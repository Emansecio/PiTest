/**
 * Cache keepalive (P3 — docs/proposals/2026-07-22-propostas-fronteira.md).
 *
 * Anthropic's default prompt-cache retention expires ~5 minutes after the last
 * read. While the session sits idle waiting for the user, that TTL lapses and
 * the next turn re-writes the whole cacheable prefix (system prompt + tools +
 * message history) at ~1.25x the base input price instead of re-reading it at
 * ~0.1x. A `max_tokens: 1` ping against the SAME prefix costs a fraction of
 * that rewrite and renews the TTL, so this keeps pinging on a short interval
 * while the session is genuinely idle.
 *
 * Kill-switch: `PIT_NO_CACHE_KEEPALIVE`.
 *
 * The scheduler (`CacheKeepalive`) is 100% dependency-injected — timers,
 * gates, and the ping itself are all callbacks — so it is testable without
 * real timers or network access (see test/cache-keepalive.test.ts).
 * `createCacheKeepalive` below wires it to a live `AgentSession` (real Node
 * timers + the session's own state as gate inputs + an actual provider call).
 */

import type { Agent } from "@pit/agent-core";
import type { Context, Model } from "@pit/ai";
import { completeSimple, recordDiagnostic } from "@pit/ai";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import type { CompactionController } from "./agent-session-compaction.ts";
import type { ContextUsage } from "./extensions/index.js";
import { compactToolsForProviderContext } from "./tool-wire-schema.ts";

/** Delay before the first (and every subsequent) keepalive ping while idle: ~4m30s. */
export const CACHE_KEEPALIVE_INTERVAL_MS = 270_000;

/**
 * Max pings fired per idle period. Two pings from a single idle-start covers
 * ~9 minutes of scheduled activity; the second ping's TTL renewal extends
 * live coverage to ~13-14 minutes total before the session gives up and waits
 * for the next real turn.
 */
export const CACHE_KEEPALIVE_MAX_PINGS = 2;

/** Minimum wire prefix (system prompt + tools + messages) worth keeping alive. */
export const CACHE_KEEPALIVE_MIN_WIRE_TOKENS = 15_000;

/**
 * Opaque handle abstraction over a scheduled timer so tests can inject a fake
 * one instead of real Node timers.
 */
export interface CacheKeepaliveTimer {
	now(): number;
	/**
	 * Schedule `callback` after `delayMs`. Real implementations MUST NOT let
	 * this keep the process alive (call `.unref()` on any real Node timer) —
	 * the CLI has to be able to exit while a keepalive is pending.
	 */
	setTimer(callback: () => void, delayMs: number): unknown;
	clearTimer(handle: unknown): void;
}

/**
 * All gates a ping must clear, evaluated fresh at fire time (not at schedule
 * time) — session state (streaming, model, context size, in-flight
 * compaction) can all change during the idle wait.
 */
export interface CacheKeepaliveGates {
	/** False when PIT_NO_CACHE_KEEPALIVE is set. */
	isEnabled(): boolean;
	/** True only for an Anthropic model whose cache retention is the short (default ~5min) kind. */
	isEligibleModel(): boolean;
	/** True when the session is not currently streaming a response. */
	isIdle(): boolean;
	/** True when the wire prefix is large enough that a ping's own cost is worth paying. */
	hasLargeEnoughPrefix(): boolean;
	/** True when a background/precomputed compaction is in flight and about to change the window. */
	isCompactionInFlight(): boolean;
}

export interface CacheKeepaliveDeps {
	timer: CacheKeepaliveTimer;
	gates: CacheKeepaliveGates;
	/**
	 * Perform one ping (build the wire context, call the provider, record the
	 * diagnostic). Must never throw — resolves `true` on a successful ping,
	 * `false` on any failure (network, auth, provider error response).
	 */
	ping(): Promise<boolean>;
}

/**
 * Drives the idle-ping schedule for one session.
 *
 * `scheduleIdle()` arms (or re-arms) the timer every time the session reaches
 * a natural end-of-turn point; it is safe to call repeatedly (e.g. once per
 * post-run check while a goal continuation loop settles) — re-arming does not
 * touch the per-idle-period ping budget. `onActivity()` tears the timer down
 * and resets that budget; call it whenever a genuinely new user/extension
 * turn starts — the turn itself is the refresh, no ping is needed.
 */
export class CacheKeepalive {
	private readonly deps: CacheKeepaliveDeps;
	private timerHandle: unknown;
	private pingCount = 0;
	private pinging = false;
	/** Bumped by onActivity() so a ping already in flight cannot resurrect a stale reschedule after new activity started. */
	private generation = 0;

	constructor(deps: CacheKeepaliveDeps) {
		this.deps = deps;
	}

	/**
	 * Arm the idle timer. No-op while a ping is already in flight (it
	 * reschedules itself on success), past the per-idle-period cap, or when
	 * the kill-switch is set.
	 */
	scheduleIdle(): void {
		if (this.pinging) return;
		if (!this.deps.gates.isEnabled()) return;
		if (this.pingCount >= CACHE_KEEPALIVE_MAX_PINGS) return;
		this.clearTimer();
		this.timerHandle = this.deps.timer.setTimer(() => {
			this.timerHandle = undefined;
			void this.fire();
		}, CACHE_KEEPALIVE_INTERVAL_MS);
	}

	/** Cancel any pending timer and reset the per-idle-period ping budget. Call at the start of every new user-initiated turn. */
	onActivity(): void {
		this.generation++;
		this.clearTimer();
		this.pingCount = 0;
	}

	private clearTimer(): void {
		if (this.timerHandle !== undefined) {
			this.deps.timer.clearTimer(this.timerHandle);
			this.timerHandle = undefined;
		}
	}

	private async fire(): Promise<void> {
		if (this.pinging) return;
		const { gates } = this.deps;
		if (
			!gates.isEnabled() ||
			!gates.isEligibleModel() ||
			!gates.isIdle() ||
			!gates.hasLargeEnoughPrefix() ||
			gates.isCompactionInFlight()
		) {
			// A gate blocked this attempt: give up quietly for the rest of this
			// idle period. The next real end-of-turn calls scheduleIdle() again.
			return;
		}
		const gen = this.generation;
		this.pinging = true;
		let ok = false;
		try {
			ok = await this.deps.ping();
		} finally {
			// Cleared BEFORE the reschedule below: scheduleIdle() itself no-ops
			// while pinging is true, so a success reschedule must see it settled.
			this.pinging = false;
		}
		// New activity (a real turn) started while the ping was in flight —
		// onActivity() already reset the budget/timer; don't resurrect it.
		if (gen !== this.generation) return;
		if (ok) {
			this.pingCount++;
			this.scheduleIdle();
		}
	}
}

/** Minimal view of AgentSession this module needs — kept narrow so it's easy to satisfy from a test double. */
export interface CacheKeepaliveHost {
	readonly agent: Agent;
	readonly compaction: CompactionController;
	readonly model: Model<any> | undefined;
	readonly isStreaming: boolean;
	getContextUsage(): ContextUsage | undefined;
	getCompactionRequestAuth(model: Model<any>): Promise<{ apiKey?: string; headers?: Record<string, string> }>;
}

/**
 * Whether `model` uses Anthropic's short (default, ~5min) cache retention —
 * the case this feature targets. Mirrors the default in
 * packages/ai/src/providers/anthropic.ts's getAnthropicCompat()
 * (`supportsLongCacheRetention ?? !isFireworks`): callers only ever reach
 * this after confirming `model.provider === "anthropic"`, so `isFireworks` is
 * always false here and the default collapses to `true` — long retention is
 * only ruled out when a compat override explicitly says so.
 */
export function modelHasShortCacheRetention(model: Model<any>): boolean {
	return model.compat?.supportsLongCacheRetention === false;
}

function createGatesForHost(host: CacheKeepaliveHost): CacheKeepaliveGates {
	return {
		isEnabled: () => !isTruthyEnvFlag(process.env.PIT_NO_CACHE_KEEPALIVE),
		isEligibleModel: () => {
			const model = host.model;
			if (!model || model.provider !== "anthropic") return false;
			return modelHasShortCacheRetention(model);
		},
		isIdle: () => !host.isStreaming,
		hasLargeEnoughPrefix: () => {
			const wireTokens = host.getContextUsage()?.wireTokens;
			return typeof wireTokens === "number" && wireTokens >= CACHE_KEEPALIVE_MIN_WIRE_TOKENS;
		},
		isCompactionInFlight: () => host.compaction.backgroundCompactionPromise !== undefined,
	};
}

/**
 * Build the ping context as close as possible to what the real send path
 * would ship: same system prompt, same message-prefix (via the agent's own
 * `convertToLlm`), and — when the lazy-tool-schema economy is on, as it is by
 * default — the same compacted tool surface `_installWireToolEconomyHook`
 * applies to every real request (`compactToolsForProviderContext` memoizes on
 * the `tools` array reference, so this returns the exact same object a real
 * turn would send whenever `agent.state.tools` hasn't changed). The call is
 * discarded: nothing here touches session state or the transcript. Divergence
 * in the message tail (e.g. a live-prune transform a real send would also
 * apply) is acceptable — prompt-cache breakpoints only need the PREFIX to
 * match byte-for-byte, not the tail.
 */
async function buildPingContext(host: CacheKeepaliveHost): Promise<Context> {
	const messages = await host.agent.convertToLlm(host.agent.state.messages);
	const context: Context = {
		systemPrompt: host.agent.state.systemPrompt,
		messages,
		tools: host.agent.state.tools,
	};
	if (isTruthyEnvFlag(process.env.PIT_NO_LAZY_TOOL_SCHEMAS)) return context;
	return compactToolsForProviderContext(context);
}

async function pingHost(host: CacheKeepaliveHost): Promise<boolean> {
	const model = host.model;
	if (!model) return false;
	try {
		const context = await buildPingContext(host);
		const { apiKey, headers } = await host.getCompactionRequestAuth(model);
		const response = await completeSimple(model, context, { maxTokens: 1, apiKey, headers });
		if (response.stopReason === "error") {
			recordDiagnostic({
				category: "cache.keepalive",
				level: "warn",
				source: "cache-keepalive.ping",
				context: { note: `failed model=${model.id} ${(response.errorMessage ?? "").slice(0, 150)}`.trim() },
			});
			return false;
		}
		recordDiagnostic({
			category: "cache.keepalive",
			level: "info",
			source: "cache-keepalive.ping",
			context: { note: `ok model=${model.id}` },
		});
		return true;
	} catch (error) {
		// Fail-open: a ping is a nice-to-have, never worth surfacing to the user.
		const note = error instanceof Error ? error.message : String(error);
		recordDiagnostic({
			category: "cache.keepalive",
			level: "warn",
			source: "cache-keepalive.ping",
			context: { note: `threw model=${model.id} ${note}`.slice(0, 200) },
		});
		return false;
	}
}

const nodeTimer: CacheKeepaliveTimer = {
	now: () => Date.now(),
	setTimer(callback, delayMs) {
		const handle = setTimeout(callback, delayMs);
		(handle as { unref?: () => void }).unref?.();
		return handle;
	},
	clearTimer(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

/** Wire a `CacheKeepalive` to a live session: real (unref'd) Node timers, session-state gates, and an actual (discarded) provider ping. */
export function createCacheKeepalive(host: CacheKeepaliveHost): CacheKeepalive {
	return new CacheKeepalive({
		timer: nodeTimer,
		gates: createGatesForHost(host),
		ping: () => pingHost(host),
	});
}
