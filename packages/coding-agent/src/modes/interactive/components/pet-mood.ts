/**
 * PetMood — the pet companion's minimal mood state machine.
 *
 * Pure and deterministic (clock + RNG injected), so the transitions and the
 * per-frame {@link PetParams} it produces are trivially unit-testable with no
 * terminal or timers. The mascot's *look* is entirely two numbers the renderers
 * already understand — `blinkK` (eye squint: 1 open, ~0.08 closed) and
 * `eyeShift` (horizontal gaze) — so every mood is just a different animation of
 * those two, sampled at `now`.
 *
 * Moods (driven by the agent lifecycle, see interactive-mode.ts):
 *   - idle     — eyes open, a natural blink every ~6–9 s (jittered).
 *   - thinking — eyes half-closed (0.75), a slow ~2 s horizontal sweep.
 *   - working  — a faster (~0.8 s) sweep while a tool runs.
 *   - done     — a single double-blink, then auto-returns to idle.
 *   - error    — two quick horizontal shakes, then auto-returns to idle.
 *
 * `done`/`error` are transient: {@link PetMood.tick} auto-transitions them back
 * to `idle` once their animation window elapses. Under reduced motion the pet is
 * frozen open (params always `{ blinkK: 1, eyeShift: 0 }`) and `done`/`error`
 * collapse to `idle` — no animation at all.
 */

import type { PetParams } from "@pit/tui";

export type PetMoodState = "idle" | "thinking" | "working" | "done" | "error";

/** Tunable timings (ms). Exposed for tests to assert phase boundaries. */
export const PET_MOOD_TIMINGS = {
	/** Idle blink cadence window; the next blink lands at a uniform pick in [min, max]. */
	idleBlinkMinMs: 6000,
	idleBlinkMaxMs: 9000,
	/** How long an idle blink holds the eyes shut. */
	blinkDurationMs: 150,
	/** Total length of the `done` double-blink before it returns to idle. */
	doneMs: 480,
	/** Total length of the `error` shake before it returns to idle. */
	errorMs: 480,
} as const;

const EYE_OPEN = 1;
const EYE_CLOSED = 0.08;
const THINKING_K = 0.75;
const WORKING_K = 0.82;
/** Thinking sweep: slow, gentle scan. */
const THINKING_PERIOD_MS = 2000;
const THINKING_AMP = 0.07;
/** Working sweep: faster alternation while a tool executes. */
const WORKING_PERIOD_MS = 800;
const WORKING_AMP = 0.09;
/** Error shake: two full oscillations over errorMs (period = errorMs / 2). */
const ERROR_AMP = 0.14;

/** Sinusoidal horizontal sweep of amplitude `amp` and the given period. */
function sweep(elapsedMs: number, periodMs: number, amp: number): number {
	return Math.sin((elapsedMs / periodMs) * Math.PI * 2) * amp;
}

/** `done` double-blink: closed·open·closed·open across four equal segments. */
function doubleBlink(elapsedMs: number): number {
	const seg = PET_MOOD_TIMINGS.doneMs / 4;
	if (elapsedMs < seg) return EYE_CLOSED;
	if (elapsedMs < seg * 2) return EYE_OPEN;
	if (elapsedMs < seg * 3) return EYE_CLOSED;
	return EYE_OPEN;
}

/** `error` shake: two horizontal oscillations, eyes staying open, no new color. */
function shake(elapsedMs: number): number {
	if (elapsedMs >= PET_MOOD_TIMINGS.errorMs) return 0;
	return sweep(elapsedMs, PET_MOOD_TIMINGS.errorMs / 2, ERROR_AMP);
}

export interface PetMoodOptions {
	now?: number;
	reducedMotion?: boolean;
	/** Injectable RNG (returns [0, 1)) for deterministic idle-blink scheduling in tests. */
	rng?: () => number;
}

export class PetMood {
	private state: PetMoodState = "idle";
	/** Clock value at which the current state was entered. */
	private since: number;
	/** Scheduled start of the next idle blink. */
	private idleBlinkAt: number;
	private readonly rng: () => number;
	private readonly reducedMotion: boolean;

	constructor(options: PetMoodOptions = {}) {
		const now = options.now ?? 0;
		this.reducedMotion = options.reducedMotion ?? false;
		this.rng = options.rng ?? Math.random;
		this.since = now;
		this.idleBlinkAt = this.scheduleIdleBlink(now);
	}

	get current(): PetMoodState {
		return this.state;
	}

	private scheduleIdleBlink(now: number): number {
		const { idleBlinkMinMs, idleBlinkMaxMs } = PET_MOOD_TIMINGS;
		return now + idleBlinkMinMs + this.rng() * (idleBlinkMaxMs - idleBlinkMinMs);
	}

	/**
	 * Enter a new mood. Under reduced motion the transient `done`/`error` moods
	 * collapse to `idle`. Returns true when the state actually changed.
	 */
	setState(next: PetMoodState, now: number): boolean {
		const target = this.reducedMotion && (next === "done" || next === "error") ? "idle" : next;
		if (target === this.state) return false;
		this.state = target;
		this.since = now;
		if (target === "idle") this.idleBlinkAt = this.scheduleIdleBlink(now);
		return true;
	}

	/**
	 * Advance transient moods (`done`/`error` → `idle`) and the idle blink
	 * schedule. Returns true when the mood STATE changed this tick. Continuous
	 * within-mood motion (sweeps, blinks) is read via {@link params}; the caller
	 * tracks that separately to decide when to repaint.
	 */
	tick(now: number): boolean {
		if (this.reducedMotion) return false;
		if (this.state === "done" && now - this.since >= PET_MOOD_TIMINGS.doneMs) {
			return this.setState("idle", now);
		}
		if (this.state === "error" && now - this.since >= PET_MOOD_TIMINGS.errorMs) {
			return this.setState("idle", now);
		}
		if (this.state === "idle" && now >= this.idleBlinkAt + PET_MOOD_TIMINGS.blinkDurationMs) {
			this.idleBlinkAt = this.scheduleIdleBlink(now);
		}
		return false;
	}

	/** The pet's eye parameters for the current mood, sampled at `now`. */
	params(now: number): PetParams {
		if (this.reducedMotion) return { blinkK: EYE_OPEN, eyeShift: 0 };
		const elapsed = now - this.since;
		switch (this.state) {
			case "idle": {
				const blinking = now >= this.idleBlinkAt && now < this.idleBlinkAt + PET_MOOD_TIMINGS.blinkDurationMs;
				return { blinkK: blinking ? EYE_CLOSED : EYE_OPEN, eyeShift: 0 };
			}
			case "thinking":
				return { blinkK: THINKING_K, eyeShift: sweep(elapsed, THINKING_PERIOD_MS, THINKING_AMP) };
			case "working":
				return { blinkK: WORKING_K, eyeShift: sweep(elapsed, WORKING_PERIOD_MS, WORKING_AMP) };
			case "done":
				return { blinkK: doubleBlink(elapsed), eyeShift: 0 };
			case "error":
				return { blinkK: EYE_OPEN, eyeShift: shake(elapsed) };
		}
	}
}
