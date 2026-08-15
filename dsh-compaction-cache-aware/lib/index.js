//#region lib/index.js
/**
* Cache-aware compaction backend.
*
* Subclasses `BasicCompactionEngine` (decision D3) and overrides exactly two
* hooks:
* - `compactIfNeeded`: cold-refusal policy for pressure triggers (plan §7);
* - `summarize`: route hot/cold — hot replays the prefix via
*   `super.summarize` (byte-identical to stock dsh), cold runs a transcript
*   summarization call (plan §5/§6).
*
* Service name stays `"compaction"` (inherited), so `/compact`,
* context-overflow recovery, and the tool-result pruner resolve this engine
* unchanged. Range selection, retention, transactions, durability, stability
* checks, and summary-size validation all stay in the base class.
*
* @module @septtpes/dsh-compaction-cache-aware
*/
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { BlockAssembler, LlmError, contentHasImage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { CacheAwareConfigSchema, resolveOwnConfig, resolveTargetPolicy, splitConfig } from "./config.js";
import { decideCompactionRoute } from "./decision.js";
import { estimateReplayTokens, estimateTextTokens, renderTranscript } from "./transcript.js";

/**
* Cold-path system prompt: the summarizer is a compaction engine fed a flat
* transcript (plan §6.3). Deliberately NOT the conversation's own system
* prompt — the cold call must not share the main dialogue prefix.
*/
const TRANSCRIPT_SYSTEM_PROMPT = [
	"You are the compaction engine of an AI coding assistant. Your input is a flattened transcript of a conversation segment, including tool calls and their results.",
	"Condense it into a structured checkpoint that lets another model resume the work with no loss of essential context."
].join(" ");

/**
* Cold-path summarization instruction.
*
* Verbatim copy of `COMPACTION_INSTRUCTION` from
* dsh-compaction-basic/lib/index.js:218-253 (unexported), with the single
* wording change "the conversation ABOVE" → "the transcript ABOVE". The
* prior-checkpoint merge rule stays unchanged: the transcript may carry an old
* `<compacted-summary>` block and the summarizer must consolidate it.
* When upgrading dsh, diff against that constant (plan §12 drift list).
*/
const SUMMARY_OPEN_TAG = "<compacted-summary>";
const SUMMARY_CLOSE_TAG = "</compacted-summary>";
const CHECKPOINT_INSTRUCTION = [
	"You are now acting as a compaction engine for this AI coding assistant. Condense the transcript ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
	"",
	"Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write \"(none)\" for an empty section — never drop a section.",
	"",
	"## Primary Request and Intent",
	"- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
	"",
	"## Key Technical Concepts",
	"- [technologies, frameworks, patterns, and conventions in play]",
	"",
	"## Files and Code",
	"- [exact path: why it matters, key changes or snippets]",
	"",
	"## Errors and Fixes",
	"- [error: how it was resolved, plus any related user feedback]",
	"",
	"## Pending Jobs",
	"- [explicitly requested work not yet completed]",
	"",
	"## Current Work",
	"- [precisely what was in progress at this checkpoint]",
	"",
	"## Next Step",
	"- [the single next action, directly in line with the most recent request, or \"(none)\"]",
	"",
	"## Critical Context",
	"- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]",
	"",
	"Rules:",
	"- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.",
	"- Capture user feedback and explicit instructions faithfully, especially corrections.",
	"- Do NOT mention this summarization request or that the context was compacted.",
	"- Output only the checkpoint text: do not call any tool or take any other action.",
	`- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`
].join("\n");

/**
* Map a terminal summarization finish to its fail-closed error.
* Replicated from the unexported `finishError`
* (dsh-compaction-basic/lib/index.js:336-351) so the cold call fails exactly
* like the base replay call (plan §6.2).
* @param finish - the BlockAssembler's terminal finish.
* @returns the error to throw, or undefined for a clean stop.
*/
function finishError(finish) {
	switch (finish.kind) {
		case "error":
		case "aborted": {
			const error = new Error(finish.failure.message);
			error.code = finish.failure.code;
			return error;
		}
		case "max-tokens": {
			const error = /* @__PURE__ */ new Error("summarization truncated at the token cap (incomplete checkpoint)");
			error.code = "MAX_TOKENS";
			return error;
		}
		default: return;
	}
}

/**
* Reject visual output and keep only text before synthesizing a user message.
* Replicated from the unexported `summaryText`
* (dsh-compaction-basic/lib/index.js:353-356) — same contract, same errors.
* @param blocks - assembled raw output blocks.
* @returns text-only summary blocks.
*/
function summaryText(blocks) {
	if (contentHasImage(blocks)) throw new LlmError("compaction summary cannot contain image output", "UNSUPPORTED_CONTENT");
	return blocks.filter((block) => block.type === "text");
}

/**
* Resolve the summarization target for the cold call, replicating the
* priority of the unexported target resolution inside `summarizeWithLlm`
* (dsh-compaction-basic/lib/index.js:268-278): explicitly configured
* summarization provider/model, then the latest request header's config, then
* the agent's own options.
* @param agent - agent handle.
* @param config - validated base-engine defaults (`this.config`).
* @returns the target route.
*/
function resolveColdTarget(agent, config) {
	const configured = config.summarizationProvider.length === 0 ? void 0 : {
		provider: config.summarizationProvider,
		model: config.summarizationModel
	};
	const latest = agent.session.requestHeader()?.config;
	const agentTarget = agent.options.provider !== void 0 && agent.options.provider.length > 0 && agent.options.model !== void 0 && agent.options.model.length > 0 ? {
		provider: agent.options.provider,
		model: agent.options.model
	} : void 0;
	const target = configured ?? latest ?? agentTarget;
	if (target === void 0) throw new Error("no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields");
	return target;
}

/**
* Cache-aware compaction engine.
*
* `inject` is inherited from the base class (`["llm", "tokenMeter",
* "sessions"]`, plan §3.3).
*/
var CacheAwareCompactionEngine = class extends BasicCompactionEngine {
	/** Base keys (verbatim) plus own keys `coldMode` / `cachePolicy` (plan §3.4). */
	static Config = CacheAwareConfigSchema;

	/** Resolved own configuration (coldMode, cachePolicy). */
	own;

	constructor(ctx, config = {}) {
		// Strip own keys first: the base resolveConfig strictly rejects unknown
		// keys, and the own keys are never valid base keys (plan §3.3).
		const { base, own } = splitConfig(config);
		super(ctx, base);
		this.own = resolveOwnConfig(own);
		ctx.logger.info(`cache-aware compaction: engine constructed coldMode=${this.own.coldMode} cachePolicy=${this.own.cachePolicy}`);
	}

	/**
	* Cold/hot decision for one decision point (plan §4, decision.js).
	* @param agent - agent whose session log is scanned.
	* @returns the decision record.
	*/
	decide(agent) {
		return decideCompactionRoute(agent, this.own.cachePolicy);
	}

	/**
	* Log one decision line (plan §3.5).
	* @param decision - the decision record.
	* @param trigger - the trigger label for the log line.
	*/
	logDecision(decision, trigger) {
		const route = decision.key === null ? "-" : `${decision.key.provider}/${decision.key.model}`;
		const lastUsage = decision.sample === null ? "-" : `cacheRead=${decision.sample.usage.cacheReadTokens},cacheWrite=${decision.sample.usage.cacheWriteTokens},uncachedInput=${decision.sample.usage.uncachedInputTokens}`;
		this.ctx.logger.info(`cache-aware compaction: route=${route} trigger=${trigger} decision=${decision.decision} coldMode=${this.own.coldMode} cachePolicy=${this.own.cachePolicy} lastUsage={${lastUsage}} reason=${decision.reason}`);
	}

	/**
	* Strategy entry (plan §7): refuse cold pressure compactions when
	* `coldMode: refuse` — but NEVER refuse a context-overflow, which must
	* force progress. Every other case falls through to the base engine.
	* @param agent - agent whose session is measured.
	* @param trigger - `pressure` or `context-overflow`.
	* @param signal - live turn cancellation signal.
	* @returns the base result (compaction result or null).
	*/
	async compactIfNeeded(agent, trigger, signal) {
		const decision = this.decide(agent);
		if (decision.decision === "cold" && this.own.coldMode === "refuse" && trigger === "pressure") {
			const route = decision.key === null ? "-" : `${decision.key.provider}/${decision.key.model}`;
			this.ctx.logger.warn(`cache-aware compaction: skipping cold compaction (coldMode=refuse, route=${route}, reason=${decision.reason}); session will keep growing until overflow`);
			return null;
		}
		return super.compactIfNeeded(agent, trigger, signal);
	}

	/**
	* Sole subclass customization hook (base contract): dispatch hot/cold.
	* Hot returns the stock replay summarization (byte-identical behavior);
	* cold runs the transcript summarization.
	* @param input - replayed conversation prefix `{ system?, tools?, messages }`.
	* @param agent - supplies routed-model history, fallback model, and session id.
	* @param signal - optional cancellation forwarded to the adapter.
	* @returns the same envelope as the base `summarizeWithLlm`.
	*/
	async summarize(input, agent, signal) {
		const decision = this.decide(agent);
		this.logDecision(decision, "compact");
		if (decision.decision === "cold") return this.transcribeSummarize(input, agent, signal);
		return super.summarize(input, agent, signal);
	}

	/**
	* Cold transcript summarization (plan §6): flatten the region, guard
	* against a transcript no smaller than the replay input, then run one
	* dedicated `ctx.llm.stream` call whose system prompt and messages are NOT
	* a prefix of the main dialogue — it cannot hit the warm cache, which is
	* exactly what a cold path wants (it pays for a small transcript instead
	* of a full-miss replay).
	* @param input - replayed conversation prefix.
	* @param agent - agent handle.
	* @param signal - optional cancellation.
	* @returns the base-compatible summary envelope.
	*/
	async transcribeSummarize(input, agent, signal) {
		const transcript = renderTranscript(input.messages);
		const transcriptTokens = estimateTextTokens(transcript);
		const replayTokens = estimateReplayTokens(this.ctx.tokenMeter, input);
		if (transcriptTokens >= replayTokens) {
			// Degenerate region (huge tool output, tiny messages): transcription
			// would not save input tokens — fall back to the stock replay path
			// (plan §11.4).
			this.ctx.logger.warn(`cache-aware compaction: transcript (${transcriptTokens} est tokens) not smaller than replay input (${replayTokens}); falling back to default replay summarization`);
			return super.summarize(input, agent, signal);
		}
		const target = resolveColdTarget(agent, this.config);
		const policy = resolveTargetPolicy(this.config, target);
		const assembler = new BlockAssembler();
		const options = {
			provider: target.provider,
			model: target.model,
			messages: [
				createUserMessage({
					content: [{
						type: "text",
						text: `${transcript}\n\n${CHECKPOINT_INSTRUCTION}`
					}],
					source: {
						kind: "plugin",
						plugin: "dsh-compaction-cache-aware"
					}
				})
			],
			system: TRANSCRIPT_SYSTEM_PROMPT,
			maxTokens: policy.maxTokens,
			sessionId: agent.session.id,
			purpose: "compaction",
			...signal === void 0 ? {} : { signal }
		};
		for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk);
		const error = finishError(assembler.finish);
		if (error !== void 0) throw error;
		const rawOutput = assembler.blocks();
		const summary = summaryText(rawOutput);
		if (!summary.some((block) => block.text.trim().length > 0)) throw new Error("summarization produced no text summary content");
		return {
			summary,
			rawOutput,
			llmStreamCall: true,
			provider: options.provider,
			model: options.model,
			maxTokens: policy.maxTokens,
			...assembler.usage === void 0 ? {} : { usage: assembler.usage }
		};
	}
};
//#endregion
export { CacheAwareCompactionEngine, CacheAwareCompactionEngine as default };
