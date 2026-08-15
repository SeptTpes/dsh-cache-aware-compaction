import { test } from "node:test";
import assert from "node:assert/strict";
import { CacheAwareCompactionEngine } from "../lib/index.js";

const P = "opencode-go";
const M = "deepseek-v4-flash";

/** Minimal ctx satisfying Service + base auto-registration + engine calls. */
function fakeCtx(overrides = {}) {
	const logs = { info: [], warn: [] };
	const ctx = {
		logger: {
			info: (message) => logs.info.push(message),
			warn: (message) => logs.warn.push(message)
		},
		reflect: { provide: () => {} },
		on: () => {},
		get: () => void 0,
		llm: null,
		tokenMeter: null,
		...overrides,
		_logs: logs
	};
	return ctx;
}

function fakeSession({ usageEvents = [], headerConfig = { provider: P, model: M } } = {}) {
	return {
		id: "session-1",
		events: usageEvents,
		// `null` means "no header yet" (destructuring defaults cannot be
		// overridden back to undefined).
		requestHeader: () => headerConfig === null ? void 0 : { config: headerConfig }
	};
}

function fakeAgent(session) {
	return { session, options: {} };
}

function usageEvent({ cacheRead = 0, cacheWrite = 0, input = 100 }, seq = 0) {
	return {
		seq,
		type: "assistant/message",
		data: {
			message: { role: "assistant", content: [{ type: "text", text: "ok" }], source: { kind: "model", provider: P, model: M } },
			usage: { inputTokens: input, outputTokens: 10, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }
		}
	};
}

/** A stream producing one text block, usage, and a clean stop. */
async function* textStream(blocks, usage) {
	yield { type: "block-start", index: 0, blockType: "text" };
	yield { type: "text-delta", index: 0, text: blocks };
	yield { type: "block-end", index: 0, block: { type: "text", text: blocks } };
	yield { type: "usage", usage: usage ?? { inputTokens: 50, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 } };
	yield { type: "finish", reason: { kind: "stop" } };
}

function recordingLlm(callLog) {
	return {
		async *stream(options) {
			callLog.push(options);
			yield* textStream("## checkpoint\n- fact");
		}
	};
}

const input = (messages) => ({ system: "you are the assistant", tools: [{ name: "t" }], messages });

test("constructor splits config, resolves own defaults, and logs construction", () => {
	const ctx = fakeCtx();
	const engine = new CacheAwareCompactionEngine(ctx, { thresholdRatio: 0.75, maxTokens: 4096 });
	assert.equal(engine.own.coldMode, "transcribe");
	assert.equal(engine.own.cachePolicy, "auto");
	assert.equal(engine.config.thresholdRatio, 0.75);
	assert.equal(engine.config.maxTokens, 4096);
	assert.ok(ctx._logs.info.some((line) => line.includes("cache-aware compaction: engine constructed coldMode=transcribe cachePolicy=auto")));
});

test("constructor rejects invalid own keys and forwards unknown base keys to the base validator", () => {
	assert.throws(() => new CacheAwareCompactionEngine(fakeCtx(), { coldMode: "bogus" }), /coldMode/);
	assert.throws(() => new CacheAwareCompactionEngine(fakeCtx(), { unknownBaseKey: 1 }), /unknown key/);
});

test("decide honors cachePolicy override", () => {
	const engine = new CacheAwareCompactionEngine(fakeCtx(), { cachePolicy: "cold" });
	const d = engine.decide(fakeAgent(fakeSession()));
	assert.equal(d.decision, "cold");
	assert.equal(d.reason, "policy-override");
});

test("refuse + cold + pressure skips without calling the base engine", async () => {
	const ctx = fakeCtx({
		tokenMeter: { measure: () => { throw new Error("base engine must not run"); } }
	});
	const engine = new CacheAwareCompactionEngine(ctx, { coldMode: "refuse", cachePolicy: "cold" });
	const result = await engine.compactIfNeeded(fakeAgent(fakeSession()), "pressure", new AbortController().signal);
	assert.equal(result, null);
	assert.ok(ctx._logs.warn.some((line) => line.includes("skipping cold compaction") && line.includes("session will keep growing until overflow")));
});

test("refuse + cold + context-overflow still runs the base engine (never refuses overflow)", async () => {
	const ctx = fakeCtx({
		tokenMeter: { measure: () => { throw new Error("base engine ran"); } }
	});
	const engine = new CacheAwareCompactionEngine(ctx, { coldMode: "refuse", cachePolicy: "cold" });
	await assert.rejects(
		engine.compactIfNeeded(fakeAgent(fakeSession()), "context-overflow", new AbortController().signal),
		/base engine ran/
	);
	assert.equal(ctx._logs.warn.length, 0);
});

test("transcribe mode + cold + pressure runs the base engine", async () => {
	const ctx = fakeCtx({
		tokenMeter: { measure: () => { throw new Error("base engine ran"); } }
	});
	const engine = new CacheAwareCompactionEngine(ctx, { cachePolicy: "cold" });
	await assert.rejects(
		engine.compactIfNeeded(fakeAgent(fakeSession()), "pressure", new AbortController().signal),
		/base engine ran/
	);
});

test("hot decision dispatches to the stock replay summarizer (byte-identical call shape)", async () => {
	const callLog = [];
	const ctx = fakeCtx({
		llm: recordingLlm(callLog),
		tokenMeter: { estimateMessage: () => 10 }
	});
	const engine = new CacheAwareCompactionEngine(ctx, { cachePolicy: "hot" });
	const messages = [{ role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user" } }];
	const result = await engine.summarize(input(messages), fakeAgent(fakeSession({ usageEvents: [usageEvent({ cacheRead: 0 })] })), void 0);
	// Envelope matches the base summarizeWithLlm contract.
	assert.equal(result.llmStreamCall, true);
	assert.equal(result.provider, P);
	assert.equal(result.model, M);
	assert.equal(result.maxTokens, 8192);
	assert.equal(result.summary[0].type, "text");
	assert.ok(result.usage);
	// Call shape is the stock replay: input system/tools/messages + base instruction.
	assert.equal(callLog.length, 1);
	const options = callLog[0];
	assert.equal(options.system, "you are the assistant");
	assert.equal(options.tools.length, 1);
	assert.equal(options.messages.length, messages.length + 1);
	assert.ok(options.messages.at(-1).content[0].text.includes("the conversation ABOVE"));
	assert.ok(options.messages.at(-1).content[0].text.includes("## Primary Request and Intent"));
});

test("auto decision with a warm sample (cacheRead > 0) dispatches to the stock replay summarizer", async () => {
	const callLog = [];
	const ctx = fakeCtx({ llm: recordingLlm(callLog), tokenMeter: { estimateMessage: () => 10 } });
	const engine = new CacheAwareCompactionEngine(ctx, { cachePolicy: "auto" });
	const messages = [{ role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } }];
	await engine.summarize(input(messages), fakeAgent(fakeSession({ usageEvents: [usageEvent({ cacheRead: 500 })] })), void 0);
	assert.ok(callLog[0].messages.at(-1).content[0].text.includes("the conversation ABOVE"));
});

test("auto decision with cacheWrite > 0 only is warm (first request wrote the prefix)", async () => {
	const callLog = [];
	const ctx = fakeCtx({ llm: recordingLlm(callLog), tokenMeter: { estimateMessage: () => 10 } });
	const engine = new CacheAwareCompactionEngine(ctx, { cachePolicy: "auto" });
	const messages = [{ role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } }];
	await engine.summarize(input(messages), fakeAgent(fakeSession({ usageEvents: [usageEvent({ cacheWrite: 800 })] })), void 0);
	assert.ok(callLog[0].messages.at(-1).content[0].text.includes("the conversation ABOVE"));
});

test("auto decision with a cold sample dispatches to the transcript summarizer", async () => {
	const callLog = [];
	const ctx = fakeCtx({ llm: recordingLlm(callLog), tokenMeter: { estimateMessage: () => 10 } });
	const engine = new CacheAwareCompactionEngine(ctx, { cachePolicy: "auto" });
	const messages = [
		{ role: "user", content: [{ type: "text", text: "do the thing" }], source: { kind: "user" } },
		{ role: "assistant", content: [{ type: "text", text: "done" }], source: { kind: "model", provider: P, model: M } }
	];
	const result = await engine.summarize(input(messages), fakeAgent(fakeSession({ usageEvents: [usageEvent({ cacheRead: 0, cacheWrite: 0 })] })), void 0);
	assert.equal(result.llmStreamCall, true);
	assert.equal(result.provider, P);
	assert.equal(result.model, M);
	assert.equal(result.maxTokens, 8192);
	// The transcript call must NOT replay the conversation prefix.
	const options = callLog[0];
	assert.equal(options.messages.length, 1);
	assert.notEqual(options.system, "you are the assistant");
	assert.ok(options.system.includes("compaction engine"));
	const text = options.messages[0].content[0].text;
	assert.ok(text.includes("[user] do the thing"));
	assert.ok(text.includes("[assistant] done"));
	assert.ok(text.includes("the transcript ABOVE"));
	assert.ok(text.includes("## Primary Request and Intent"));
	assert.equal(options.purpose, "compaction");
	assert.equal(options.sessionId, "session-1");
});

test("cold decision logs the decision line with route and lastUsage", async () => {
	const ctx = fakeCtx({ llm: recordingLlm([]), tokenMeter: { estimateMessage: () => 10 } });
	const engine = new CacheAwareCompactionEngine(ctx, { cachePolicy: "auto" });
	await engine.summarize(input([{ role: "user", content: [{ type: "text", text: "x" }], source: { kind: "user" } }]),
		fakeAgent(fakeSession({ usageEvents: [usageEvent({ cacheRead: 0, cacheWrite: 0, input: 77 })] })), void 0);
	const line = ctx._logs.info.find((l) => l.includes("cache-aware compaction: route="));
	assert.ok(line.includes(`route=${P}/${M}`));
	assert.ok(line.includes("decision=cold"));
	assert.ok(line.includes("coldMode=transcribe"));
	assert.ok(line.includes("cachePolicy=auto"));
	assert.ok(line.includes("lastUsage={cacheRead=0,cacheWrite=0,uncachedInput=77}"));
});

test("transcript larger than the replay input falls back to the stock replay summarizer with a warning", async () => {
	const callLog = [];
	const big = "x".repeat(1000);
	const ctx = fakeCtx({
		llm: recordingLlm(callLog),
		// The meter prices the big message at 1 token, so the replay input
		// (system + tools + message ≈ 14 est tokens) is far cheaper than the
		// transcript (≈336 est tokens) → the guard must fall back.
		tokenMeter: { estimateMessage: () => 1 }
	});
	const engine = new CacheAwareCompactionEngine(ctx, { cachePolicy: "cold" });
	const messages = [{ role: "user", content: [{ type: "text", text: big }], source: { kind: "user" } }];
	await engine.summarize(input(messages), fakeAgent(fakeSession()), void 0);
	assert.ok(ctx._logs.warn.some((line) => line.includes("not smaller than replay input")));
	// The fallback call is the stock replay shape.
	const options = callLog[0];
	assert.equal(options.system, "you are the assistant");
	assert.equal(options.messages.length, messages.length + 1);
	assert.ok(options.messages.at(-1).content[0].text.includes("the conversation ABOVE"));
});

test("modelPolicies override drives the cold call maxTokens", async () => {
	const callLog = [];
	const ctx = fakeCtx({ llm: recordingLlm(callLog), tokenMeter: { estimateMessage: () => 10 } });
	const engine = new CacheAwareCompactionEngine(ctx, {
		cachePolicy: "cold",
		maxTokens: 8192,
		modelPolicies: [{ provider: P, model: M, maxTokens: 2048 }]
	});
	await engine.summarize(input([{ role: "user", content: [{ type: "text", text: "x" }], source: { kind: "user" } }]),
		fakeAgent(fakeSession()), void 0);
	assert.equal(callLog[0].maxTokens, 2048);
});

test("cold summarizer throws when the stream fails, mirroring the base finishError contract", async () => {
	const ctx = fakeCtx({
		llm: {
			async *stream() {
				yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "slow down" } } };
			}
		},
		tokenMeter: { estimateMessage: () => 10 }
	});
	const engine = new CacheAwareCompactionEngine(ctx, { cachePolicy: "cold" });
	await assert.rejects(
		engine.summarize(input([{ role: "user", content: [{ type: "text", text: "x" }], source: { kind: "user" } }]),
			fakeAgent(fakeSession()), void 0),
		(error) => error.message === "slow down" && error.code === "RATE_LIMIT"
	);
});

test("cold summarizer rejects an empty summary like the base", async () => {
	const ctx = fakeCtx({
		llm: {
			async *stream() {
				yield { type: "finish", reason: { kind: "stop" } };
			}
		},
		tokenMeter: { estimateMessage: () => 10 }
	});
	const engine = new CacheAwareCompactionEngine(ctx, { cachePolicy: "cold" });
	await assert.rejects(
		engine.summarize(input([{ role: "user", content: [{ type: "text", text: "x" }], source: { kind: "user" } }]),
			fakeAgent(fakeSession()), void 0),
		/no text summary content/
	);
});

test("cold target resolution prefers configured summarization model over the conversation route", async () => {
	const callLog = [];
	const ctx = fakeCtx({ llm: recordingLlm(callLog), tokenMeter: { estimateMessage: () => 10 } });
	const engine = new CacheAwareCompactionEngine(ctx, {
		cachePolicy: "cold",
		summarizationProvider: "opencode-go",
		summarizationModel: "deepseek-v4-pro"
	});
	await engine.summarize(input([{ role: "user", content: [{ type: "text", text: "x" }], source: { kind: "user" } }]),
		fakeAgent(fakeSession()), void 0);
	assert.equal(callLog[0].provider, "opencode-go");
	assert.equal(callLog[0].model, "deepseek-v4-pro");
});

test("cold target resolution throws the base no-target error without any route", async () => {
	const ctx = fakeCtx({ llm: recordingLlm([]), tokenMeter: { estimateMessage: () => 10 } });
	const engine = new CacheAwareCompactionEngine(ctx, { cachePolicy: "cold" });
	await assert.rejects(
		engine.summarize(input([{ role: "user", content: [{ type: "text", text: "x" }], source: { kind: "user" } }]),
			fakeAgent(fakeSession({ usageEvents: [], headerConfig: null })), void 0),
		/no provider\/model available for summarization/
	);
});
