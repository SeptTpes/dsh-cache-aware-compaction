//#region lib/transcript.js
/**
* Pure flattening of compaction-region messages into one transcript text
* (plan §6.1), plus conservative token estimates for the transcript-vs-replay
* guard.
*
* Input messages are already the base engine's `buildSummarizationInput`
* projection (`deriveEventMessage`: user/message, assistant/message,
* tool/result; dsh-session/lib/index.js:278-287).
*
* @module @septtpes/dsh-compaction-cache-aware/transcript
*/

/** Render one content block to a transcript line; never throws (plan §6.1). */
function renderBlock(block, role, labeled) {
	switch (block?.type) {
		case "text": {
			const text = block.text.trim();
			if (text.length === 0) return "";
			// Nested text (inside a tool result) renders raw: the `[tool result]`
			// label already identifies it (plan §6.1 `{text}`).
			return labeled ? `[${role === "assistant" ? "assistant" : "user"}] ${text}` : text;
		}
		case "tool-call": {
			const name = typeof block.name === "string" ? block.name : "";
			// dsh tool-call `arguments` is already a JSON string; render it
			// verbatim (plan §6.1's JSON.stringify intent) without re-encoding.
			const args = typeof block.arguments === "string" ? block.arguments : String(block.arguments);
			return `[assistant → tool call: ${name}(${args})]`;
		}
		case "tool-result": {
			// Recursive render; nested images already emit their own
			// `[image omitted]` marker, so no extra contentHasImage append is
			// needed (plan §6.1's marker is subsumed — documented deviation).
			const nested = renderBlocks(block.content ?? [], "user", false).trim();
			return `[tool result]${nested.length > 0 ? ` ${nested}` : ""}`;
		}
		case "image": return "[image omitted]";
		// Unknown or unlisted types (reasoning included) degrade to a marker
		// rather than throwing — information loss is acceptable, a crash is not.
		default: return `[block: ${block?.type}]`;
	}
}

/** Render an ordered block list to transcript lines (joined by newline). */
function renderBlocks(blocks, role, labeled) {
	const lines = [];
	for (const block of blocks ?? []) {
		const line = renderBlock(block, role, labeled);
		if (line.length > 0) lines.push(line);
	}
	return lines.join("\n");
}

/**
* Flatten one message into transcript lines.
* A tool-result message (role user, `tool-result` content) renders under the
* `[tool result]` label; assistant messages render their text under
* `[assistant]` and their tool calls under `[assistant → tool call: ...]`.
* Messages with no renderable content produce no lines (plan §6.1).
* @param message - one projected LLM message `{ role, content, source }`.
* @returns the flattened text, or "" when nothing is renderable.
*/
export function renderMessage(message) {
	return renderBlocks(message?.content ?? [], message?.role, true);
}

/**
* Flatten a list of messages into a single transcript text (plan §6.1 format):
*
* ```
* [user] <text>
* [assistant] <text>
* [assistant → tool call: name(argsJson)]
* [tool result] <text>
* ```
*
* @param messages - projected compaction-region messages.
* @returns the transcript, or "" for an empty region.
*/
export function renderTranscript(messages) {
	const parts = [];
	for (const message of messages ?? []) {
		const text = renderMessage(message);
		if (text.length > 0) parts.push(text);
	}
	return parts.join("\n");
}

/**
* Conservative text→token estimate (chars / 3, plan §6.1).
* @param text - text to estimate.
* @returns a non-negative token estimate.
*/
export function estimateTextTokens(text) {
	return Math.ceil([...text].length / 3);
}

/**
* Estimate the replay-token cost of the base engine's summarization input
* (plan §6.1): system and tools by chars/3, each message through the token
* meter's message estimator when available, else chars/3.
* @param meter - token-meter-like with `estimateMessage(message)`.
* @param input - `{ system?, tools?, messages }` from `buildSummarizationInput`.
* @returns a non-negative token estimate.
*/
export function estimateReplayTokens(meter, input) {
	let total = 0;
	if (input?.system !== void 0) total += estimateTextTokens(input.system);
	if (input?.tools !== void 0) total += estimateTextTokens(JSON.stringify(input.tools));
	for (const message of input?.messages ?? []) {
		if (message === null) continue;
		if (typeof meter?.estimateMessage === "function") total += meter.estimateMessage(message);
		else total += estimateTextTokens(JSON.stringify(message));
	}
	return total;
}
//#endregion
