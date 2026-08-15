//#region lib/decision.js
/**
* Pure cache-hot/cold decision for the cache-aware compaction engine.
*
* Stateless: every decision is derived on demand from the agent's own session
* log, so concurrent agents/sessions are naturally isolated and the decision
* survives process restarts (plan §4.5).
*
* @module @septtpes/dsh-compaction-cache-aware/decision
*/

/**
* Resolve the durable provider/model route of the conversation.
* Priority mirrors the base engine: the latest request header's config, then
* the agent's own options (plan §4.2).
* @param agent - agent-like `{ session: { requestHeader() }, options }`.
* @returns the route key, or null when neither source has a full pair.
*/
export function routeKey(agent) {
	const config = agent.session.requestHeader()?.config;
	if (config !== void 0 && typeof config.provider === "string" && config.provider.length > 0 && typeof config.model === "string" && config.model.length > 0) return {
		provider: config.provider,
		model: config.model
	};
	const options = agent.options ?? {};
	if (typeof options.provider === "string" && options.provider.length > 0 && typeof options.model === "string" && options.model.length > 0) return {
		provider: options.provider,
		model: options.model
	};
	return null;
}

/**
* Scan the session log in reverse for the newest usage sample attributed to
* the given route. Attribution: assistant messages carry `message.source`
* with the provider/model that produced them
* (dsh-agent-loop/lib/index.js:642-648). Events without a usage record are
* skipped (they cannot provide a sample); an empty-content assistant message
* is still a legitimate usage host and counts as a sample.
* @param session - session-like with an `events` array (indexed by seq).
* @param key - the exact `{ provider, model }` route to match.
* @returns the newest matching sample, or null when none exists.
*/
export function latestUsageSample(session, key) {
	const events = session.events;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type !== "assistant/message") continue;
		const source = event.data?.message?.source;
		if (source?.provider !== key.provider || source?.model !== key.model) continue;
		const usage = event.data?.usage;
		if (usage === void 0) continue;
		return {
			event,
			usage: {
				cacheReadTokens: usage.cacheReadTokens ?? 0,
				cacheWriteTokens: usage.cacheWriteTokens ?? 0,
				uncachedInputTokens: usage.inputTokens ?? 0
			}
		};
	}
	return null;
}

/**
* Decide hot or cold for one compaction decision point (plan §4).
*
* Rules:
* 1. `cachePolicy !== "auto"` forces the decision (experiment override).
* 2. No route key → hot (base `summarize` will throw its own no-target error).
* 3. No usage sample for the route (model has not replied yet) → hot: the
*    session is small and the base behavior is the conservative default.
* 4. Sample with `cacheReadTokens > 0 || cacheWriteTokens > 0` → hot.
*    `cacheWrite > 0` also counts as warm: the FIRST request wrote the prefix
*    cache, so the immediately following replay call would hit it; looking
*    only at `cacheRead` would misjudge "written then guaranteed hit" as cold.
* 5. Both zero → cold.
*
* Known limitation (v0.1, accepted per plan §11.3): a long-idle session whose
* provider-evicted cache still reports the last warm usage is misjudged hot.
*
* @param agent - agent-like handle (session + options).
* @param cachePolicy - resolved plugin cachePolicy (`auto` | `hot` | `cold`).
* @returns the decision record for logging and dispatch.
*/
export function decideCompactionRoute(agent, cachePolicy) {
	const key = routeKey(agent);
	if (cachePolicy === "hot") return {
		decision: "hot",
		key,
		sample: null,
		reason: "policy-override"
	};
	if (cachePolicy === "cold") return {
		decision: "cold",
		key,
		sample: null,
		reason: "policy-override"
	};
	if (key === null) return {
		decision: "hot",
		key: null,
		sample: null,
		reason: "no-route"
	};
	const sample = latestUsageSample(agent.session, key);
	if (sample === null) return {
		decision: "hot",
		key,
		sample: null,
		reason: "no-sample"
	};
	if (sample.usage.cacheReadTokens > 0 || sample.usage.cacheWriteTokens > 0) return {
		decision: "hot",
		key,
		sample,
		reason: "cache-warm"
	};
	return {
		decision: "cold",
		key,
		sample,
		reason: "cache-cold"
	};
}
//#endregion
