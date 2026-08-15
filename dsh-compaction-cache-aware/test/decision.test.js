import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCompactionRoute, latestUsageSample, routeKey } from "../lib/decision.js";

const P = "opencode-go";
const M = "deepseek-v4-flash";

function usage({ input = 100, cacheRead = 0, cacheWrite = 0 } = {}) {
	return { inputTokens: input, outputTokens: 10, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
}

function assistantEvent(provider, model, u, seq = 0) {
	return {
		seq,
		type: "assistant/message",
		data: {
			message: { role: "assistant", content: [{ type: "text", text: "ok" }], source: { kind: "model", provider, model } },
			usage: u
		}
	};
}

function session(events, headerConfig) {
	return {
		events,
		requestHeader: () => headerConfig === void 0 ? void 0 : { config: headerConfig }
	};
}

function agent(s, options) {
	return { session: s, options: options ?? {} };
}

test("routeKey prefers request header config over agent options", () => {
	const a = agent(session([], { provider: P, model: M }), { provider: "other", model: "x" });
	assert.deepEqual(routeKey(a), { provider: P, model: M });
});

test("routeKey falls back to agent options", () => {
	const a = agent(session([]), { provider: P, model: M });
	assert.deepEqual(routeKey(a), { provider: P, model: M });
});

test("routeKey returns null without any route", () => {
	assert.equal(routeKey(agent(session([]), {})), null);
	assert.equal(routeKey(agent(session([]), { provider: P })), null);
	assert.equal(routeKey(agent(session([]), { provider: "", model: "" })), null);
});

test("policy override: hot and cold force decisions without scanning", () => {
	const a = agent(session([], { provider: P, model: M }), {});
	let d = decideCompactionRoute(a, "hot");
	assert.deepEqual(d, { decision: "hot", key: { provider: P, model: M }, sample: null, reason: "policy-override" });
	d = decideCompactionRoute(a, "cold");
	assert.deepEqual(d, { decision: "cold", key: { provider: P, model: M }, sample: null, reason: "policy-override" });
});

test("no route -> hot with reason no-route", () => {
	const a = agent(session([assistantEvent(P, M, usage({ cacheRead: 5 }))]), {});
	const d = decideCompactionRoute(a, "auto");
	assert.equal(d.decision, "hot");
	assert.equal(d.key, null);
	assert.equal(d.reason, "no-route");
});

test("no sample for the route -> hot with reason no-sample", () => {
	const a = agent(session([], { provider: P, model: M }), {});
	const d = decideCompactionRoute(a, "auto");
	assert.equal(d.decision, "hot");
	assert.equal(d.reason, "no-sample");
});

test("cacheRead > 0 -> hot", () => {
	const a = agent(session([assistantEvent(P, M, usage({ cacheRead: 500 }))], { provider: P, model: M }), {});
	const d = decideCompactionRoute(a, "auto");
	assert.equal(d.decision, "hot");
	assert.equal(d.reason, "cache-warm");
	assert.equal(d.sample.usage.cacheReadTokens, 500);
});

test("cacheWrite > 0 only -> hot (first request wrote the prefix)", () => {
	const a = agent(session([assistantEvent(P, M, usage({ cacheWrite: 800 }))], { provider: P, model: M }), {});
	const d = decideCompactionRoute(a, "auto");
	assert.equal(d.decision, "hot");
	assert.equal(d.reason, "cache-warm");
});

test("both cache buckets zero -> cold", () => {
	const a = agent(session([assistantEvent(P, M, usage())], { provider: P, model: M }), {});
	const d = decideCompactionRoute(a, "auto");
	assert.equal(d.decision, "cold");
	assert.equal(d.reason, "cache-cold");
});

test("missing optional usage fields normalize to zero", () => {
	const a = agent(session([assistantEvent(P, M, { inputTokens: 50, outputTokens: 5 })], { provider: P, model: M }), {});
	const d = decideCompactionRoute(a, "auto");
	assert.equal(d.decision, "cold");
	assert.deepEqual(d.sample.usage, { cacheReadTokens: 0, cacheWriteTokens: 0, uncachedInputTokens: 50 });
});

test("samples from other models are ignored (isolation by route)", () => {
	const events = [
		assistantEvent("other-provider", "other-model", usage({ cacheRead: 900 }), 0),
		assistantEvent(P, M, usage(), 1)
	];
	const a = agent(session(events, { provider: P, model: M }), {});
	const d = decideCompactionRoute(a, "auto");
	assert.equal(d.decision, "cold");
});

test("reverse scan: newest matching sample wins", () => {
	const events = [
		assistantEvent(P, M, usage({ cacheRead: 900 }), 0),
		assistantEvent(P, M, usage(), 1)
	];
	const a = agent(session(events, { provider: P, model: M }), {});
	const d = decideCompactionRoute(a, "auto");
	assert.equal(d.decision, "cold");
	assert.equal(d.sample.event.seq, 1);
});

test("events without usage are skipped (cannot be samples)", () => {
	const events = [
		assistantEvent(P, M, usage({ cacheRead: 900 }), 0),
		{ seq: 1, type: "assistant/message", data: { message: { role: "assistant", content: [], source: { kind: "model", provider: P, model: M } } } }
	];
	const a = agent(session(events, { provider: P, model: M }), {});
	const d = decideCompactionRoute(a, "auto");
	// The newest matching event carries no usage; the older warm sample decides.
	assert.equal(d.decision, "hot");
	assert.equal(d.sample.event.seq, 0);
});

test("non-assistant events and sparse log are safe", () => {
	const events = [
		{ seq: 0, type: "turn/start", data: {} },
		null,
		assistantEvent(P, M, usage({ cacheRead: 1 }), 2)
	];
	const a = agent(session(events, { provider: P, model: M }), {});
	const d = decideCompactionRoute(a, "auto");
	assert.equal(d.decision, "hot");
});

test("latestUsageSample matches only the exact route", () => {
	const events = [assistantEvent(P, M, usage({ cacheRead: 3 }), 0)];
	assert.equal(latestUsageSample(session(events, {}), { provider: P, model: "other" }), null);
	assert.equal(latestUsageSample(session(events, {}), { provider: "other", model: M }), null);
	assert.ok(latestUsageSample(session(events, {}), { provider: P, model: M }));
});
