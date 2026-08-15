import { test } from "node:test";
import assert from "node:assert/strict";
import { CacheAwareConfigSchema, DEFAULTS, OWN_CONFIG_KEYS, resolveOwnConfig, resolveTargetPolicy, splitConfig } from "../lib/config.js";

test("splitConfig strips own keys and keeps base keys", () => {
	const { base, own } = splitConfig({
		thresholdRatio: 0.75,
		retainRatio: 0.2,
		coldMode: "refuse",
		cachePolicy: "cold"
	});
	assert.deepEqual(base, { thresholdRatio: 0.75, retainRatio: 0.2 });
	assert.deepEqual(own, { coldMode: "refuse", cachePolicy: "cold" });
});

test("splitConfig handles empty and own-only configs", () => {
	assert.deepEqual(splitConfig(), { base: {}, own: {} });
	assert.deepEqual(splitConfig({ coldMode: "transcribe" }), { base: {}, own: { coldMode: "transcribe" } });
	assert.deepEqual(splitConfig({ auto: false }), { base: { auto: false }, own: {} });
});

test("splitConfig never leaks own keys into base", () => {
	for (const key of OWN_CONFIG_KEYS) {
		const { base, own } = splitConfig({ [key]: "x", thresholdRatio: 0.8 });
		assert.equal(key in base, false);
		assert.equal(key in own, true);
	}
});

test("resolveOwnConfig applies defaults", () => {
	const resolved = resolveOwnConfig();
	assert.deepEqual(resolved, DEFAULTS);
	assert.equal(resolved.coldMode, "transcribe");
	assert.equal(resolved.cachePolicy, "auto");
});

test("resolveOwnConfig accepts both cold modes and all cache policies", () => {
	assert.equal(resolveOwnConfig({ coldMode: "refuse" }).coldMode, "refuse");
	assert.equal(resolveOwnConfig({ coldMode: "transcribe" }).coldMode, "transcribe");
	assert.equal(resolveOwnConfig({ cachePolicy: "hot" }).cachePolicy, "hot");
	assert.equal(resolveOwnConfig({ cachePolicy: "cold" }).cachePolicy, "cold");
	assert.equal(resolveOwnConfig({ cachePolicy: "auto" }).cachePolicy, "auto");
});

test("resolveOwnConfig rejects invalid values and unknown keys", () => {
	assert.throws(() => resolveOwnConfig({ coldMode: "summarize" }), /coldMode/);
	assert.throws(() => resolveOwnConfig({ cachePolicy: "warm" }), /cachePolicy/);
	assert.throws(() => resolveOwnConfig({ thresholdRatio: 0.8 }), /unknown key/);
});

test("resolveOwnConfig returns a frozen object", () => {
	const resolved = resolveOwnConfig();
	assert.equal(Object.isFrozen(resolved), true);
	assert.throws(() => { resolved.coldMode = "refuse"; }, TypeError);
});

test("CacheAwareConfigSchema accepts base keys and own defaults", () => {
	const normalized = CacheAwareConfigSchema({
		thresholdRatio: 0.8,
		retainRatio: 0.16,
		maxTokens: 4096,
		modelPolicies: [{
			provider: "opencode-go",
			model: "deepseek-v4-pro",
			maxTokens: 2048
		}],
		auto: false
	});
	assert.equal(normalized.thresholdRatio, 0.8);
	assert.equal(normalized.maxTokens, 4096);
	assert.equal(normalized.modelPolicies[0].provider, "opencode-go");
	assert.equal(normalized.coldMode, "transcribe");
	assert.equal(normalized.cachePolicy, "auto");
});

test("CacheAwareConfigSchema accepts own keys and passes unknown keys through", () => {
	const normalized = CacheAwareConfigSchema({ coldMode: "refuse", cachePolicy: "hot" });
	assert.equal(normalized.coldMode, "refuse");
	assert.equal(normalized.cachePolicy, "hot");
	assert.throws(() => CacheAwareConfigSchema({ coldMode: "bogus" }), /coldMode/);
	assert.throws(() => CacheAwareConfigSchema({ cachePolicy: "bogus" }), /cachePolicy/);
	// schemastery keeps unknown keys in the normalized output; strictness is
	// enforced downstream: the base engine's resolveConfig rejects unknown
	// base keys and resolveOwnConfig rejects unknown own keys.
	assert.equal(CacheAwareConfigSchema({ unknownKey: 1 }).unknownKey, 1);
	const { base } = splitConfig({ unknownKey: 1 });
	assert.equal(base.unknownKey, 1);
	assert.throws(() => resolveOwnConfig({ unknownKey: 1 }), /unknown key/);
});

test("resolveTargetPolicy falls back to top-level defaults", () => {
	const config = {
		summarizationProvider: "",
		summarizationModel: "",
		maxTokens: 8192,
		modelPolicies: []
	};
	const policy = resolveTargetPolicy(config, { provider: "p", model: "m" });
	assert.deepEqual(policy, {
		target: { provider: "p", model: "m" },
		summarizationProvider: "",
		summarizationModel: "",
		maxTokens: 8192
	});
});

test("resolveTargetPolicy honors exact modelPolicies override", () => {
	const config = {
		summarizationProvider: "opencode-go",
		summarizationModel: "deepseek-v4-flash",
		maxTokens: 8192,
		modelPolicies: [{
			provider: "opencode-go",
			model: "deepseek-v4-pro",
			maxTokens: 4096,
			summarizationModel: "deepseek-v4-flash"
		}]
	};
	const hit = resolveTargetPolicy(config, { provider: "opencode-go", model: "deepseek-v4-pro" });
	assert.equal(hit.maxTokens, 4096);
	assert.equal(hit.summarizationModel, "deepseek-v4-flash");
	// Non-matching target inherits top-level values.
	const miss = resolveTargetPolicy(config, { provider: "opencode-go", model: "deepseek-v4-mini" });
	assert.equal(miss.maxTokens, 8192);
	assert.equal(miss.summarizationModel, "deepseek-v4-flash");
});
