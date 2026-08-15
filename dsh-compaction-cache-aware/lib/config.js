//#region lib/config.js
/**
* Configuration for the cache-aware compaction engine: key splitting, own-key
* resolution, the plugin Config schema, and the cold-call target-policy
* resolution.
*
* @module @septtpes/dsh-compaction-cache-aware/config
*/
import z from "@deepseek-ai/schemastery";
import { deepFreeze } from "@deepseek-ai/dsh-llm";

/** Keys this plugin owns; every other key is forwarded to the base engine. */
export const OWN_CONFIG_KEYS = [
	"coldMode",
	"cachePolicy"
];

/** Allowed cold-mode values (decision D1). */
export const COLD_MODES = [
	"transcribe",
	"refuse"
];

/** Allowed cache-policy values; `auto` is the plan's §4 rule, hot/cold are experiment overrides. */
export const CACHE_POLICIES = [
	"auto",
	"hot",
	"cold"
];

/** Plugin defaults (decision D1: default cold mode is transcribe). */
export const DEFAULTS = deepFreeze({
	coldMode: "transcribe",
	cachePolicy: "auto"
});

/**
* Split one plugin config into the base-engine slice and this plugin's own
* slice. The base engine (`BasicCompactionEngine`) rejects unknown keys via
* `validateKeys` (dsh-compaction-basic/lib/index.js:57,183-184), so the own
* keys must never reach `super(ctx, base)`.
* @param config - raw plugin configuration after Loader normalization.
* @returns `base` (forwarded verbatim to the base constructor) and `own`.
*/
export function splitConfig(config = {}) {
	const base = {};
	const own = {};
	for (const [key, value] of Object.entries(config)) {
		if (OWN_CONFIG_KEYS.includes(key)) own[key] = value;
		else base[key] = value;
	}
	return { base, own };
}

/**
* Resolve and validate this plugin's own configuration slice.
* @param own - the own-key slice from {@link splitConfig}.
* @returns a detached immutable own configuration.
*/
export function resolveOwnConfig(own = {}) {
	for (const key of Object.keys(own)) {
		if (!OWN_CONFIG_KEYS.includes(key)) throw new Error(`CacheAwareCompactionConfig: unknown key "${key}" (allowed: coldMode, cachePolicy)`);
	}
	const coldMode = own.coldMode ?? DEFAULTS.coldMode;
	if (!COLD_MODES.includes(coldMode)) throw new Error(`CacheAwareCompactionConfig: coldMode (${String(coldMode)}) must be one of ${COLD_MODES.join(", ")}`);
	const cachePolicy = own.cachePolicy ?? DEFAULTS.cachePolicy;
	if (!CACHE_POLICIES.includes(cachePolicy)) throw new Error(`CacheAwareCompactionConfig: cachePolicy (${String(cachePolicy)}) must be one of ${CACHE_POLICIES.join(", ")}`);
	return deepFreeze({
		coldMode,
		cachePolicy
	});
}

// Base Config schema fields copied VERBATIM from
// dsh-compaction-basic/lib/index.js:714-759 (unexported). When upgrading dsh,
// diff against that file (plan §12 drift list).
const thresholdRatioSchema = z.number();
const retainRatioSchema = z.number();
const retainTokensSchema = z.number().step(1).min(0);
const summarizationProviderSchema = z.string();
const summarizationModelSchema = z.string();
const maxTokensSchema = z.number().step(1).min(1);
const compactionRetriesSchema = z.number().step(1).min(0);
const maxOverflowRetriesSchema = z.number().step(1).min(0);
const modelPolicy = z.object({
	provider: z.string().required(),
	model: z.string().required(),
	thresholdRatio: thresholdRatioSchema,
	retainRatio: retainRatioSchema,
	retainTokens: retainTokensSchema,
	summarizationProvider: summarizationProviderSchema,
	summarizationModel: summarizationModelSchema,
	maxTokens: maxTokensSchema,
	compactionRetries: compactionRetriesSchema,
	maxOverflowRetries: maxOverflowRetriesSchema
});

/**
* Plugin Config schema: every base key (verbatim copy) plus the own keys.
* The Loader validates against this, so a preset row may configure both the
* base engine and this plugin in one object.
*/
export const CacheAwareConfigSchema = z.object({
	thresholdRatio: thresholdRatioSchema,
	retainRatio: retainRatioSchema,
	retainTokens: retainTokensSchema,
	summarizationProvider: summarizationProviderSchema,
	summarizationModel: summarizationModelSchema,
	maxTokens: maxTokensSchema,
	compactionRetries: compactionRetriesSchema,
	maxOverflowRetries: maxOverflowRetriesSchema,
	modelPolicies: z.array(modelPolicy),
	auto: z.boolean(),
	coldMode: z.union([z.const("transcribe"), z.const("refuse")]).default("transcribe"),
	cachePolicy: z.union([z.const("auto"), z.const("hot"), z.const("cold")]).default("auto")
});

/**
* Merge the exact provider/model override over the validated default policy
* for the COLD summarization call. Replicated from the unexported
* `resolveTargetPolicy` (dsh-compaction-basic/lib/index.js:83-99); only the
* fields the cold call consumes are carried (plan §6.2).
* @param config - validated base-engine defaults (`this.config`).
* @param target - exact durable provider/model route to match.
* @returns a detached policy for the cold call.
*/
export function resolveTargetPolicy(config, target) {
	const override = config.modelPolicies.find((policy) => policy.provider === target.provider && policy.model === target.model);
	return deepFreeze({
		target: {
			provider: target.provider,
			model: target.model
		},
		summarizationProvider: override?.summarizationProvider ?? config.summarizationProvider,
		summarizationModel: override?.summarizationModel ?? config.summarizationModel,
		maxTokens: override?.maxTokens ?? config.maxTokens
	});
}
//#endregion
