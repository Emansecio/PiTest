/**
 * Cache keepalive (P3 — docs/proposals/2026-07-22-propostas-fronteira.md).
 *
 * Anthropic's prompt-cache retention expires after its TTL lapses following the
 * last read — ~5 minutes for the default "short" retention, 1 hour for "long"
 * (1h TTL, the main interactive session's default; see anthropic.ts
 * getCacheControl). While the session sits idle waiting for the user, that TTL
 * lapses and the next turn re-writes the whole cacheable prefix (system prompt
 * + tools + message history) instead of re-reading it at ~0.1x — at ~1.25x the
 * base input price on a short-retention prefix, ~2.0x on a long one. A
 * `max_tokens: 1` ping against the SAME prefix costs a fraction of that rewrite
 * and renews the TTL, so this keeps pinging while the session is genuinely idle.
 * The effective wire retention (env `PIT_CACHE_RETENTION` > session option >
 * "long" default, then clamped to short when the model lacks long-retention
 * support) picks the cadence: short → ~4m30 interval, long → ~55min interval.
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
import type { CacheRetention, Model } from "@pit/ai";
import { completeSimple, recordDiagnostic } from "@pit/ai";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import type { CompactionController } from "./agent-session-compaction.ts";
import type { ContextUsage } from "./extensions/index.js";
import { buildWireContext, effectiveWireRetention } from "./wire-context.ts";

/** Delay before each keepalive ping while idle under SHORT (~5min TTL) retention: ~4m30s. */
export const CACHE_KEEPALIVE_INTERVAL_MS = 270_000;

/**
 * Max pings fired per idle period under SHORT retention. Two pings from a single
 * idle-start covers ~9 minutes of scheduled activity; the second ping's TTL
 * renewal extends live coverage to ~13-14 minutes total before the session
 * gives up and waits for the next real turn.
 */
export const CACHE_KEEPALIVE_MAX_PINGS = 2;

/**
 * Delay before each keepalive ping while idle under LONG (1h TTL) retention:
 * ~55min. Fires just inside the 1h window so each read renews the TTL before it
 * lapses. One ping (a cache-read, ~0.1x input) is far cheaper than re-writing a
 * long-retention prefix (~2.0x input), so pinging pays off across a wide margin.
 */
export const CACHE_KEEPALIVE_LONG_INTERVAL_MS = 3_300_000;

/**
 * Max pings fired per idle period under LONG retention. Two ~55min pings reach
 * ~110min from idle-start, and the second ping's 1h TTL renewal keeps the prefix
 * live to ~170min (~2h50) before the session gives up and waits for a real turn.
 */
export const CACHE_KEEPALIVE_LONG_MAX_PINGS = 2;

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
	/** True for an Anthropic model whose effective wire retention is not "none" (short and long both qualify — retention only selects cadence, not eligibility). */
	isEligibleModel(): boolean;
	/** True when the session is not currently streaming a response. */
	isIdle(): boolean;
	/** True when the wire prefix is large enough that a ping's own cost is worth paying. */
	hasLargeEnoughPrefix(): boolean;
	/** True when a background/precomputed compaction is in flight and about to change the window. */
	isCompactionInFlight(): boolean;
	/** Idle delay before the next ping — short vs long effective retention pick different cadences; re-read fresh at each (re)schedule. */
	intervalMs(): number;
	/** Per-idle-period ping cap for the current effective retention; re-read fresh at each (re)schedule. */
	maxPings(): number;
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
		// Cap and interval are read fresh here (not captured at construction): the
		// effective retention — and thus the cadence — can flip during the idle
		// wait as the model or PIT_CACHE_RETENTION changes, and every reschedule
		// (including fire()'s own) routes through here.
		if (this.pingCount >= this.deps.gates.maxPings()) return;
		this.clearTimer();
		this.timerHandle = this.deps.timer.setTimer(() => {
			this.timerHandle = undefined;
			void this.fire();
		}, this.deps.gates.intervalMs());
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
	/** True while a Fusion turn (panel/judge/writer) is in flight — the session is busy even though isStreaming is false. */
	readonly isFusing: boolean;
	getContextUsage(): ContextUsage | undefined;
	getCompactionRequestAuth(model: Model<any>): Promise<{ apiKey?: string; headers?: Record<string, string> }>;
	/** The RAW per-session cache-retention option (undefined = provider default); resolved env-first before use. */
	getSessionCacheRetention(): CacheRetention | undefined;
}

/**
 * The retention this host's prefix will ACTUALLY get on the wire, which decides
 * the ping cadence. Host-shaped adapter over {@link effectiveWireRetention}
 * (core/wire-context.ts), which owns the resolution.
 */
export function effectiveKeepaliveRetention(host: CacheKeepaliveHost): CacheRetention {
	return effectiveWireRetention(host.model, host.getSessionCacheRetention());
}

export function createGatesForHost(host: CacheKeepaliveHost): CacheKeepaliveGates {
	return {
		isEnabled: () => !isTruthyEnvFlag(process.env.PIT_NO_CACHE_KEEPALIVE),
		// Both short and long effective retention are eligible; only "none"
		// (non-Anthropic, or PIT_CACHE_RETENTION=none) opts out entirely.
		isEligibleModel: () => effectiveKeepaliveRetention(host) !== "none",
		// Fusion turns run outside the agent loop (isStreaming stays false while the
		// panel/judge/writer work), so "idle" must exclude them too — a ping mid-fusion
		// is harmless but pointless spend.
		isIdle: () => !host.isStreaming && !host.isFusing,
		hasLargeEnoughPrefix: () => {
			const wireTokens = host.getContextUsage()?.wireTokens;
			return typeof wireTokens === "number" && wireTokens >= CACHE_KEEPALIVE_MIN_WIRE_TOKENS;
		},
		isCompactionInFlight: () => host.compaction.backgroundCompactionPromise !== undefined,
		intervalMs: () =>
			effectiveKeepaliveRetention(host) === "long" ? CACHE_KEEPALIVE_LONG_INTERVAL_MS : CACHE_KEEPALIVE_INTERVAL_MS,
		maxPings: () =>
			effectiveKeepaliveRetention(host) === "long" ? CACHE_KEEPALIVE_LONG_MAX_PINGS : CACHE_KEEPALIVE_MAX_PINGS,
	};
}

async function pingHost(host: CacheKeepaliveHost): Promise<boolean> {
	const model = host.model;
	if (!model) return false;
	const retention = effectiveKeepaliveRetention(host);
	try {
		// The ping must ride the session's own cacheable prefix — that is the whole
		// point — so it uses the shared assembly in core/wire-context.ts.
		const context = await buildWireContext(host.agent);
		const { apiKey, headers } = await host.getCompactionRequestAuth(model);
		const response = await completeSimple(model, context, { maxTokens: 1, apiKey, headers });
		if (response.stopReason === "error") {
			recordDiagnostic({
				category: "cache.keepalive",
				level: "warn",
				source: "cache-keepalive.ping",
				context: {
					note: `failed model=${model.id} retention=${retention} ${(response.errorMessage ?? "").slice(0, 150)}`.trim(),
				},
			});
			return false;
		}
		recordDiagnostic({
			category: "cache.keepalive",
			level: "info",
			source: "cache-keepalive.ping",
			context: { note: `ok model=${model.id} retention=${retention}` },
		});
		return true;
	} catch (error) {
		// Fail-open: a ping is a nice-to-have, never worth surfacing to the user.
		const note = error instanceof Error ? error.message : String(error);
		recordDiagnostic({
			category: "cache.keepalive",
			level: "warn",
			source: "cache-keepalive.ping",
			context: { note: `threw model=${model.id} retention=${retention} ${note}`.slice(0, 200) },
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
