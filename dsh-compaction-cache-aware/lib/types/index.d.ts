/**
 * Public types for @septtpes/dsh-compaction-cache-aware.
 *
 * @module @septtpes/dsh-compaction-cache-aware
 */
import type { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock, LlmUsage, Message } from "@deepseek-ai/dsh-llm";

/** Cold-mode behavior when the cache is judged cold (decision D1). */
export type ColdMode = "transcribe" | "refuse";

/** Cache-policy experiment override; `auto` follows the plan §4 rule. */
export type CachePolicy = "auto" | "hot" | "cold";

/** Resolved own configuration of this plugin. */
export interface CacheAwareOwnConfig {
    coldMode: ColdMode;
    cachePolicy: CachePolicy;
}

/** Normalized usage sample used by the hot/cold decision. */
export interface UsageBucket {
    cacheReadTokens: number;
    cacheWriteTokens: number;
    uncachedInputTokens: number;
}

/** Exact durable provider/model route. */
export interface RouteKey {
    provider: string;
    model: string;
}

/** One usage sample attributed to a route, with its source event. */
export interface UsageSample {
    event: unknown;
    usage: UsageBucket;
}

/** The hot/cold decision record produced per decision point. */
export interface CompactionDecision {
    decision: "hot" | "cold";
    key: RouteKey | null;
    sample: UsageSample | null;
    reason: "policy-override" | "no-route" | "no-sample" | "cache-warm" | "cache-cold";
}

/** Summarization input shape produced by the base engine's `buildSummarizationInput`. */
export interface SummarizationInput {
    system?: string;
    tools?: unknown[];
    messages: Message[];
}

/**
 * Cache-aware compaction engine. Registered as the `compaction` service by
 * replacing the `compaction-basic` row in an agent preset (decision D3).
 */
export declare class CacheAwareCompactionEngine extends BasicCompactionEngine {
    static Config: import("@deepseek-ai/schemastery").Schema;
    /** Resolved own configuration. */
    own: CacheAwareOwnConfig;
    constructor(ctx: Context, config?: Record<string, unknown>);
    /** Hot/cold decision for one decision point (plan §4). */
    decide(agent: unknown): CompactionDecision;
    /** Log one decision line (plan §3.5). */
    logDecision(decision: CompactionDecision, trigger: string): void;
    /** Strategy entry with cold-refusal support (plan §7). */
    compactIfNeeded(agent: unknown, trigger: "pressure" | "context-overflow", signal: AbortSignal): Promise<unknown>;
    /** Hot/cold dispatch; hot delegates to the base replay summarizer. */
    summarize(input: SummarizationInput, agent: unknown, signal?: AbortSignal): Promise<unknown>;
    /** Cold transcript summarization (plan §6). */
    transcribeSummarize(input: SummarizationInput, agent: unknown, signal?: AbortSignal): Promise<unknown>;
}

export default CacheAwareCompactionEngine;
