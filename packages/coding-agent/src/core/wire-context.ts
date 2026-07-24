/**
 * The session's WIRE PREFIX — the cacheable head of every provider request
 * (system prompt + converted message history + tool schemas) and the retention
 * that prefix will actually get on the wire.
 *
 * Three call sites need the exact same prefix for the exact same reason: they
 * all issue an off-turn request that must hit Anthropic's prompt cache instead
 * of re-writing the whole head at 1.25x–2.0x input.
 *
 *   - `core/cache-keepalive.ts` — the idle `max_tokens: 1` ping that renews the TTL.
 *   - `core/agent-session-compaction.ts` — cache-aware summarization (read the
 *     hot prefix at ~0.1x instead of serializing the window to a sibling model).
 *   - `core/agent-session-fusion.ts` — the writer's prefix-reuse path (same
 *     prefix + one trailing user block carrying the panel/judge/verify material).
 *
 * Each of those modules types the session through its OWN host interface
 * (CacheKeepaliveHost / CompactionHost / FusionHost). None of them widens to the
 * others, so the prefix assembly and the retention resolution used to be copied
 * three and two times respectively, each copy carrying a "keep in sync" comment.
 * This module owns both so there is exactly one implementation; callers pass the
 * narrowest thing that actually matters (an agent, or a model + a retention
 * option) rather than a whole host shape.
 */

import type { Agent } from "@pit/agent-core";
import type { CacheRetention, Context, Model } from "@pit/ai";
import { resolveCacheRetention } from "@pit/ai";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import { compactToolsForProviderContext } from "./tool-wire-schema.ts";

/**
 * Whether `model` uses Anthropic's short (default, ~5min) cache retention.
 * Mirrors the default in packages/ai/src/providers/anthropic.ts's
 * getAnthropicCompat() (`supportsLongCacheRetention ?? !isFireworks`): callers
 * only ever reach this after confirming `model.provider === "anthropic"`, so
 * `isFireworks` is always false here and the default collapses to `true` — long
 * retention is only ruled out when a compat override explicitly says so.
 */
export function modelHasShortCacheRetention(model: Model<any>): boolean {
	return model.compat?.supportsLongCacheRetention === false;
}

/**
 * The retention the wire prefix will ACTUALLY get for this model, which decides
 * both the keepalive ping cadence and the cache-aware compaction staleness
 * margin. Mirrors anthropic.ts getCacheControl: resolve env-first
 * (`PIT_CACHE_RETENTION` > `sessionRetention` > "long" default), then demote
 * "long" to "short" when the model lacks long-retention support (its
 * cache_control ships without the 1h ttl, so the real TTL is only ~5min).
 * Returns "none" for a missing model and for any non-Anthropic model — no other
 * provider exposes the read-at-0.1x prefix cache this arithmetic assumes.
 *
 * `sessionRetention` is the RAW per-session option (undefined = provider
 * default); it is deliberately NOT pre-resolved by the caller.
 */
export function effectiveWireRetention(
	model: Model<any> | undefined,
	sessionRetention: CacheRetention | undefined,
): CacheRetention {
	if (!model || model.provider !== "anthropic") return "none";
	const resolved = resolveCacheRetention(sessionRetention, "long");
	if (resolved === "none") return "none";
	if (resolved === "long" && !modelHasShortCacheRetention(model)) return "long";
	return "short";
}

/**
 * The only agent surface the wire prefix needs: the live state it is assembled
 * from plus the agent's own app→LLM message converter.
 */
export type WireContextAgent = Pick<Agent, "state" | "convertToLlm">;

/**
 * Optional shaping applied to the assembled prefix BEFORE the tool-economy step.
 * The one real user is Fusion's writer, which appends a trailing user block to
 * the prefix; it must run first so the tools block it carries through is the one
 * `compactToolsForProviderContext` memoizes on (see {@link buildWireContext}).
 */
export type WireContextShaper = (prefix: Context) => Context;

/**
 * Assemble the wire prefix as close as possible to what the real send path would
 * ship: same system prompt, same message prefix (via the agent's own
 * `convertToLlm`), and — when the lazy-tool-schema economy is on, as it is by
 * default — the same compacted tool surface `_installWireToolEconomyHook`
 * applies to every real request. `compactToolsForProviderContext` memoizes on
 * the `tools` array REFERENCE, so this returns the exact same tools object a
 * real turn would send whenever `agent.state.tools` hasn't changed — which is
 * what makes the prompt cache hit. `shape` must therefore pass `tools` through
 * by reference.
 *
 * Nothing here touches session state or the transcript: the resulting context is
 * for a request whose response is discarded (ping), consumed off-transcript
 * (compaction summary), or streamed as its own message (Fusion writer).
 * Divergence in the message TAIL (e.g. a live-prune transform a real send would
 * also apply) is acceptable — prompt-cache breakpoints only need the PREFIX to
 * match byte-for-byte.
 *
 * Kill-switch: `PIT_NO_LAZY_TOOL_SCHEMAS` ships the full (uncompacted) tool
 * schemas, exactly as the real send path does under that flag.
 */
export async function buildWireContext(agent: WireContextAgent, shape?: WireContextShaper): Promise<Context> {
	const messages = await agent.convertToLlm(agent.state.messages);
	const prefix: Context = {
		systemPrompt: agent.state.systemPrompt,
		messages,
		tools: agent.state.tools,
	};
	const context = shape ? shape(prefix) : prefix;
	if (isTruthyEnvFlag(process.env.PIT_NO_LAZY_TOOL_SCHEMAS)) return context;
	return compactToolsForProviderContext(context);
}
