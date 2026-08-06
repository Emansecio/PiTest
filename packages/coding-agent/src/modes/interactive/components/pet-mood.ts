/**
 * PetMood — the pet companion's mood state machine.
 *
 * Pure and deterministic (clock + RNG injected), so the transitions and the
 * per-frame {@link PetParams} it produces are trivially unit-testable with no
 * terminal or timers. A mood is nothing but an *animation* of the parameters the
 * renderers already understand: the eyes (`blinkK`, `eyeShift`, `eyeShiftY`,
 * `eyeScale`) and the body as a rigid transform (`bobX`, `bobY`, `tilt`,
 * `squash`). The silhouette itself is never re-authored — see
 * `@pit/tui`'s `pet-geometry.ts`.
 *
 * Moods (driven by the agent lifecycle, see interactive-mode.ts):
 *   - idle      — breathing, jittered (sometimes double) blinks, occasional
 *                 glances to the side that the head leans into.
 *   - watching  — the user is typing: leans in, looks down at the composer.
 *   - thinking  — eyes half-closed, slow gaze sweep, head tilting with it.
 *   - working   — faster sweep plus a rhythmic hop while a tool runs.
 *   - digesting — compaction: a slow circular gaze ("chewing the context").
 *   - waiting   — retry backoff: bored, looking up, breathing slowly.
 *   - alert     — blocked on the user (permission/picker): wide eyes, held still.
 *   - done      — a celebratory hop with a double blink, then back to idle.
 *   - error     — a damped body shake with wide eyes, then back to idle.
 *   - startled  — Esc/interrupt: an instant jump that wobbles out.
 *   - sleepy    — entered on its own after {@link PET_MOOD_TIMINGS.sleepAfterMs}
 *                 of idling: eyelids down, long deep breaths, occasional peeks.
 *
 * `done`/`error`/`startled` are transient: {@link PetMood.tick} auto-returns them
 * to `idle` once their window elapses. Under reduced motion the pet is frozen
 * open (params always `{ blinkK: 1 }`), the transients collapse to `idle`, and it
 * never falls asleep — no animation at all.
 */

import type { PetParams } from "@pit/tui";

export type PetMoodState =
	| "idle"
	| "watching"
	| "thinking"
	| "working"
	| "digesting"
	| "waiting"
	| "alert"
	| "done"
	| "error"
	| "startled"
	| "sleepy";

/** Moods an ambient (user-driven, non-turn) signal is allowed to replace. */
const AMBIENT_REPLACEABLE: ReadonlySet<PetMoodState> = new Set<PetMoodState>(["idle", "watching", "sleepy"]);

/** True when an ambient mood request may take over the current mood. */
export function isAmbientReplaceable(state: PetMoodState): boolean {
	return AMBIENT_REPLACEABLE.has(state);
}

/** Tunable timings (ms). Exposed for tests to assert phase boundaries. */
export const PET_MOOD_TIMINGS = {
	/** Idle blink cadence window; the next blink lands at a uniform pick in [min, max]. */
	idleBlinkMinMs: 3800,
	idleBlinkMaxMs: 7600,
	/** How long one blink takes to close and reopen. */
	blinkDurationMs: 170,
	/** Eyes-open gap between the two flashes of a double blink. */
	doubleBlinkGapMs: 120,
	/** Glance ("saccade") cadence and how long the pet holds the look. */
	saccadeMinMs: 3200,
	saccadeMaxMs: 6800,
	saccadeDurationMs: 820,
	/** Resting breath cycle. */
	breathPeriodMs: 4200,
	/** Total length of the `done` hop before it returns to idle. */
	doneMs: 620,
	/** Total length of the `error` shake before it returns to idle. */
	errorMs: 520,
	/** Total length of the `startled` jump before it returns to idle. */
	startledMs: 460,
	/** Uninterrupted idling after which the pet dozes off. */
	sleepAfterMs: 120_000,
	/** Mood-change crossfade: ease-lerp from previous pose into the new mood. */
	crossfadeMs: 100,
} as const;

/** Mood-change crossfade duration (ms). Alias of {@link PET_MOOD_TIMINGS.crossfadeMs}. */
export const CROSSFADE_MS = PET_MOOD_TIMINGS.crossfadeMs;

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
/** Working hop: one bounce per half-period, the "busy hands" tell. */
const WORKING_HOP_PERIOD_MS = 420;
/** Error shake: two full oscillations over errorMs (period = errorMs / 2). */
const ERROR_AMP = 0.055;
/** `done`: airborne window; the remainder of `doneMs` is the landing squash. */
const DONE_HOP_MS = 420;
/** Compaction gaze: one full circle. */
const DIGEST_PERIOD_MS = 1800;
/** Deep, slow sleeping breath. */
const SLEEP_BREATH_PERIOD_MS = 5600;
/** Chance that a scheduled idle blink is a double blink. */
const DOUBLE_BLINK_CHANCE = 0.35;

/**
 * Repaint cadence per mood (ms). The pet is sampled on a quantized clock, so a
 * mood that barely moves costs a handful of frames per second instead of the
 * ticker's full 60 — the difference between "alive" and "a space heater".
 *
 * This IS the frame-rate governor: PetCompanion compares quantized poses
 * field-wise (no string key), so a moving mood repaints once per interval.
 * The ladder is 10 / 20 / 25 / 30 fps, scaled to how much each mood moves.
 * Sixel transport applies an extra floor (~15 fps) in pet-companion. Reduced
 * motion bypasses all of it (`PetCompanion.tick` returns early; pose frozen).
 */
export function petFrameIntervalMs(state: PetMoodState): number {
	switch (state) {
		case "sleepy":
			return 100;
		case "idle":
		case "watching":
		case "waiting":
			return 50;
		case "thinking":
		case "digesting":
		case "alert":
			return 40;
		case "working":
		case "done":
		case "error":
		case "startled":
			return 33;
	}
}

/** Sinusoidal horizontal sweep of amplitude `amp` and the given period. */
function sweep(elapsedMs: number, periodMs: number, amp: number): number {
	return Math.sin((elapsedMs / periodMs) * Math.PI * 2) * amp;
}

/**
 * Breathing, sampled on the ABSOLUTE clock (not the mood's elapsed time) so it
 * carries across mood changes instead of snapping back to zero on every
 * transition — a visible hitch when the pet switches between calm moods.
 */
function breath(now: number, periodMs: number): number {
	return Math.sin((now / periodMs) * Math.PI * 2);
}

/** Eye scale of one blink: a smooth close/open over `durationMs`, `1` outside it. */
function blinkAt(elapsedMs: number, durationMs: number): number {
	if (elapsedMs < 0 || elapsedMs >= durationMs) return EYE_OPEN;
	return EYE_OPEN - (EYE_OPEN - EYE_CLOSED) * Math.sin((elapsedMs / durationMs) * Math.PI);
}

/** Two blinks separated by `gapMs` of open eyes. */
function doubleBlinkAt(elapsedMs: number, durationMs: number, gapMs: number): number {
	const first = blinkAt(elapsedMs, durationMs);
	if (first !== EYE_OPEN) return first;
	return blinkAt(elapsedMs - durationMs - gapMs, durationMs);
}

function clamp01(v: number): number {
	return Math.max(0, Math.min(1, v));
}

/** Smoothstep ease: slow in, slow out over [0, 1]. */
function easeSmoothstep(t: number): number {
	const x = clamp01(t);
	return x * x * (3 - 2 * x);
}

/**
 * Lerp every numeric {@link PetParams} channel. Missing optionals default to 0
 * (or 1 for `eyeScale` / `blinkK`) so a sparse "from" still blends cleanly.
 */
function lerpParams(from: PetParams, to: PetParams, t: number): PetParams {
	const e = easeSmoothstep(t);
	const lerp = (a: number, b: number) => a + (b - a) * e;
	return {
		blinkK: lerp(from.blinkK ?? EYE_OPEN, to.blinkK ?? EYE_OPEN),
		eyeShift: lerp(from.eyeShift ?? 0, to.eyeShift ?? 0),
		eyeShiftY: lerp(from.eyeShiftY ?? 0, to.eyeShiftY ?? 0),
		eyeScale: lerp(from.eyeScale ?? 1, to.eyeScale ?? 1),
		bobX: lerp(from.bobX ?? 0, to.bobX ?? 0),
		bobY: lerp(from.bobY ?? 0, to.bobY ?? 0),
		tilt: lerp(from.tilt ?? 0, to.tilt ?? 0),
		squash: lerp(from.squash ?? 0, to.squash ?? 0),
	};
}

export interface PetMoodOptions {
	now?: number;
	reducedMotion?: boolean;
	/** Injectable RNG (returns [0, 1)) for deterministic idle scheduling in tests. */
	rng?: () => number;
}

/** A scheduled glance: where the eyes dart to, and when. */
interface Saccade {
	at: number;
	x: number;
	y: number;
}

export class PetMood {
	private state: PetMoodState = "idle";
	/** Clock value at which the current state was entered. */
	private since: number;
	/**
	 * Clock value of the last sign of life — a mood change or a keystroke. The
	 * doze-off countdown runs off THIS, not `since`, so a pet leaning over a
	 * composer you keep typing into stays awake, while one left with half a
	 * sentence in it eventually nods off like it would when idle.
	 */
	private awakeSince: number;
	/** Scheduled start of the next blink, and whether it is a double. */
	private blinkStart: number;
	private blinkDouble = false;
	private saccade: Saccade;
	private readonly rng: () => number;
	private readonly reducedMotion: boolean;
	/** Pure pre-transition pose; null when no crossfade is running. */
	private crossfadeFrom: PetParams | null = null;
	/** Clock value when the current crossfade began. */
	private crossfadeStart = 0;

	constructor(options: PetMoodOptions = {}) {
		const now = options.now ?? 0;
		this.reducedMotion = options.reducedMotion ?? false;
		this.rng = options.rng ?? Math.random;
		this.since = now;
		this.awakeSince = now;
		this.blinkStart = this.scheduleBlink(now);
		this.saccade = this.scheduleSaccade(now);
	}

	get current(): PetMoodState {
		return this.state;
	}

	/** True until the first sampled frame at or beyond the crossfade endpoint. */
	get hasPendingCrossfade(): boolean {
		return this.crossfadeFrom !== null;
	}

	/** Quantize the animation clock from the active state's entry, never globally. */
	sampleAt(now: number, intervalMs: number): number {
		return this.since + Math.floor(Math.max(0, now - this.since) / intervalMs) * intervalMs;
	}

	/** How long the current blink (single or double) occupies. */
	private get blinkWindowMs(): number {
		const { blinkDurationMs, doubleBlinkGapMs } = PET_MOOD_TIMINGS;
		return this.blinkDouble ? blinkDurationMs * 2 + doubleBlinkGapMs : blinkDurationMs;
	}

	private scheduleBlink(now: number): number {
		const { idleBlinkMinMs, idleBlinkMaxMs } = PET_MOOD_TIMINGS;
		this.blinkDouble = this.rng() < DOUBLE_BLINK_CHANCE;
		return now + idleBlinkMinMs + this.rng() * (idleBlinkMaxMs - idleBlinkMinMs);
	}

	private scheduleSaccade(now: number): Saccade {
		const { saccadeMinMs, saccadeMaxMs } = PET_MOOD_TIMINGS;
		const dir = this.rng() < 0.5 ? -1 : 1;
		return {
			at: now + saccadeMinMs + this.rng() * (saccadeMaxMs - saccadeMinMs),
			x: dir * (0.05 + this.rng() * 0.05),
			y: (this.rng() - 0.5) * 0.06,
		};
	}

	/** Eye scale from the blink schedule, `1` between blinks. */
	private blinkFactor(now: number): number {
		const { blinkDurationMs, doubleBlinkGapMs } = PET_MOOD_TIMINGS;
		const elapsed = now - this.blinkStart;
		return this.blinkDouble
			? doubleBlinkAt(elapsed, blinkDurationMs, doubleBlinkGapMs)
			: blinkAt(elapsed, blinkDurationMs);
	}

	/**
	 * The scheduled glance, eased: a quick dart out, a hold, then a drift back.
	 * `{0, 0}` outside the glance window.
	 */
	private gaze(now: number): { x: number; y: number } {
		const dur = PET_MOOD_TIMINGS.saccadeDurationMs;
		const t = now - this.saccade.at;
		if (t < 0 || t >= dur) return { x: 0, y: 0 };
		const k = t < dur * 0.12 ? t / (dur * 0.12) : t > dur * 0.72 ? 1 - (t - dur * 0.72) / (dur * 0.28) : 1;
		return { x: this.saccade.x * k, y: this.saccade.y * k };
	}

	/**
	 * Register a sign of life without touching the mood — a keystroke into a
	 * composer the pet is already watching. Restarts the doze-off countdown.
	 */
	keepAwake(now: number): void {
		this.awakeSince = now;
	}

	/**
	 * Enter a new mood. Under reduced motion the transient moods collapse to
	 * `idle`. Returns true when the state actually changed.
	 *
	 * On a real change, the current pure pose is captured and {@link params}
	 * ease-lerps into the new mood over {@link PET_MOOD_TIMINGS.crossfadeMs}
	 * (skipped under reduced motion).
	 */
	setState(next: PetMoodState, now: number): boolean {
		const transient = next === "done" || next === "error" || next === "startled";
		const target = this.reducedMotion && transient ? "idle" : next;
		this.keepAwake(now);
		if (target === this.state) return false;
		// Snapshot the DISPLAYED pose (including any in-flight crossfade) so
		// rapid mood chains (idle→thinking→working) ease from what the user
		// actually sees, not from the pure previous-mood endpoint.
		if (!this.reducedMotion) {
			this.crossfadeFrom = this.params(now);
			this.crossfadeStart = now;
		}
		this.state = target;
		this.since = now;
		// Waking up (or settling down) restarts the ambient schedules so the pet
		// doesn't blink the instant it changes mood.
		if (target === "idle" || target === "sleepy" || target === "watching") {
			this.blinkStart = this.scheduleBlink(now);
			this.saccade = this.scheduleSaccade(now);
		}
		return true;
	}

	/**
	 * Advance transient moods (`done`/`error`/`startled` → `idle`), doze off after
	 * a long idle, and roll the blink/glance schedules forward. Returns true when
	 * the mood STATE changed this tick. Continuous within-mood motion (breathing,
	 * sweeps, blinks) is read via {@link params}; the caller tracks that separately
	 * to decide when to repaint.
	 */
	tick(now: number): boolean {
		if (this.reducedMotion) return false;
		const elapsed = now - this.since;
		if (this.state === "done" && elapsed >= PET_MOOD_TIMINGS.doneMs) return this.setState("idle", now);
		if (this.state === "error" && elapsed >= PET_MOOD_TIMINGS.errorMs) return this.setState("idle", now);
		if (this.state === "startled" && elapsed >= PET_MOOD_TIMINGS.startledMs) return this.setState("idle", now);
		const restless = this.state === "idle" || this.state === "watching";
		if (restless && now - this.awakeSince >= PET_MOOD_TIMINGS.sleepAfterMs) return this.setState("sleepy", now);
		if (now >= this.blinkStart + this.blinkWindowMs) this.blinkStart = this.scheduleBlink(now);
		if (now >= this.saccade.at + PET_MOOD_TIMINGS.saccadeDurationMs) this.saccade = this.scheduleSaccade(now);
		return false;
	}

	/**
	 * Pure scene parameters for the current mood at `now`, ignoring any in-flight
	 * crossfade. Used as the crossfade target and as the snapshot source in
	 * {@link setState}.
	 */
	private computeParams(now: number): PetParams {
		const elapsed = now - this.since;
		switch (this.state) {
			case "idle":
				return this.idleParams(now);
			case "watching":
				return this.watchingParams(now);
			case "sleepy":
				return this.sleepyParams(now);
			case "thinking":
				return this.thinkingParams(now, elapsed);
			case "working":
				return this.workingParams(now, elapsed);
			case "digesting":
				return this.digestingParams(now, elapsed);
			case "waiting":
				return this.waitingParams(now);
			case "alert":
				return this.alertParams(now, elapsed);
			case "done":
				return doneParams(elapsed);
			case "error":
				return errorParams(elapsed);
			case "startled":
				return startledParams(elapsed);
		}
	}

	/** The pet's scene parameters for the current mood, sampled at `now`. */
	params(now: number): PetParams {
		if (this.reducedMotion) return { blinkK: EYE_OPEN, eyeShift: 0 };
		const target = this.computeParams(now);
		if (this.crossfadeFrom === null) return target;
		const t = (now - this.crossfadeStart) / PET_MOOD_TIMINGS.crossfadeMs;
		if (t >= 1) {
			this.crossfadeFrom = null;
			return target;
		}
		return lerpParams(this.crossfadeFrom, target, t);
	}

	/** Resting: breathing, blinking, and glancing around the room. */
	private idleParams(now: number): PetParams {
		const b = breath(now, PET_MOOD_TIMINGS.breathPeriodMs);
		const g = this.gaze(now);
		return {
			blinkK: this.blinkFactor(now),
			eyeShift: g.x,
			eyeShiftY: g.y,
			bobY: b * 0.02,
			squash: -b * 0.03,
			tilt: -g.x * 0.35 + b * 0.01,
		};
	}

	/** The user is typing: leaned in, eyes down on the composer, quicker breath. */
	private watchingParams(now: number): PetParams {
		const b = breath(now, 3400);
		const g = this.gaze(now);
		return {
			blinkK: this.blinkFactor(now) * 0.95,
			eyeShift: -0.035 + g.x * 0.4,
			eyeShiftY: 0.045,
			eyeScale: 1.04,
			bobY: b * 0.014,
			squash: -b * 0.02,
			tilt: -0.05,
		};
	}

	/**
	 * Dozing: lids down, long deep breaths, head lolled to one side. The blink
	 * schedule is INVERTED here — a scheduled "blink" cracks the eyes open for a
	 * moment (a sleepy peek) instead of shutting them.
	 */
	private sleepyParams(now: number): PetParams {
		const b = breath(now, SLEEP_BREATH_PERIOD_MS);
		const peek = EYE_OPEN - this.blinkFactor(now);
		return {
			blinkK: 0.16 + (b + 1) * 0.03 + peek * 0.5,
			eyeShiftY: 0.03,
			bobY: b * 0.03,
			squash: -b * 0.045,
			tilt: 0.1 + b * 0.02,
		};
	}

	/**
	 * Reasoning: half-lidded, a slow scan the head leans into. Micro-blinks ride
	 * the shared idle blink schedule so the lids aren't frozen forever — base
	 * {@link THINKING_K} stays dominant; blinks only dip it a little.
	 */
	private thinkingParams(now: number, elapsed: number): PetParams {
		const s = sweep(elapsed, THINKING_PERIOD_MS, THINKING_AMP);
		const b = breath(now, 3600);
		return {
			blinkK: THINKING_K * (0.85 + 0.15 * this.blinkFactor(now)),
			eyeShift: s,
			eyeShiftY: -0.02,
			bobY: b * 0.016,
			squash: -b * 0.02,
			tilt: s * 1.1,
		};
	}

	/**
	 * A tool is running: fast scan over a rhythmic hop. Hop height uses a powered
	 * sine so the bounce softens near the apex; squash peaks on landing (hop ≈ 0).
	 */
	private workingParams(_now: number, elapsed: number): PetParams {
		const s = sweep(elapsed, WORKING_PERIOD_MS, WORKING_AMP);
		const raw = Math.abs(Math.sin((Math.PI * elapsed) / WORKING_HOP_PERIOD_MS));
		// Power > 1: more time near the ground, a slightly softer landing/takeoff.
		const hop = raw ** 1.25;
		return {
			blinkK: WORKING_K,
			eyeShift: s,
			bobY: -hop * 0.028,
			// Landing squash peaks when hop is low; mild stretch at the apex.
			squash: 0.05 * (1 - hop) - 0.018 * hop,
			tilt: s * 0.6,
		};
	}

	/** Compaction: a slow circular gaze, like chewing through the context. */
	private digestingParams(now: number, elapsed: number): PetParams {
		const a = (elapsed / DIGEST_PERIOD_MS) * Math.PI * 2;
		const b = breath(now, 3000);
		return {
			blinkK: 0.7,
			eyeShift: Math.cos(a) * 0.055,
			eyeShiftY: Math.sin(a) * 0.045,
			bobY: b * 0.018,
			squash: -b * 0.02,
			tilt: Math.cos(a) * 0.05,
		};
	}

	/** Retry backoff: bored, looking up, waiting it out. */
	private waitingParams(now: number): PetParams {
		const b = breath(now, 4800);
		return {
			blinkK: 0.5 * this.blinkFactor(now),
			eyeShift: b * 0.03,
			eyeShiftY: -0.045 + b * 0.02,
			bobY: b * 0.024,
			squash: -b * 0.03,
			tilt: 0.07,
		};
	}

	/** Blocked on the user: wide-eyed, held still, with a faint attentive tremor. */
	private alertParams(now: number, elapsed: number): PetParams {
		return {
			blinkK: this.blinkFactor(now),
			eyeShift: Math.sin(elapsed / 260) * 0.012,
			eyeScale: 1.18,
			bobY: breath(now, 2200) * 0.01,
			tilt: 0,
		};
	}
}

/** `done`: a celebratory hop with a double blink at the top, then a landing squash. */
function doneParams(elapsed: number): PetParams {
	const { blinkDurationMs, doubleBlinkGapMs } = PET_MOOD_TIMINGS;
	const blinkK = doubleBlinkAt(elapsed - 60, blinkDurationMs * 0.75, doubleBlinkGapMs * 0.75);
	if (elapsed < DONE_HOP_MS) {
		const k = Math.sin((Math.PI * elapsed) / DONE_HOP_MS);
		return {
			blinkK,
			eyeScale: 1.05,
			// Hop height and stretch are bounded by the canvas: at the apex the
			// stroke's outer edge must stay inside y = -0.5 or the sixel clips it.
			bobY: -0.07 * k,
			squash: -0.045 * k,
			tilt: Math.sin((elapsed / DONE_HOP_MS) * Math.PI * 2) * 0.05,
		};
	}
	const s = clamp01((elapsed - DONE_HOP_MS) / (PET_MOOD_TIMINGS.doneMs - DONE_HOP_MS));
	return { blinkK, eyeScale: 1.05, bobY: 0.018 * (1 - s), squash: 0.1 * (1 - s) };
}

/** `error`: a damped whole-body shake with wide eyes — no new color, just motion. */
function errorParams(elapsed: number): PetParams {
	if (elapsed >= PET_MOOD_TIMINGS.errorMs) return { blinkK: EYE_OPEN };
	const decay = 1 - elapsed / PET_MOOD_TIMINGS.errorMs;
	const shake = sweep(elapsed, PET_MOOD_TIMINGS.errorMs / 2, ERROR_AMP) * decay;
	return {
		blinkK: EYE_OPEN,
		eyeShift: -shake * 0.5,
		eyeScale: 1 + 0.15 * decay,
		bobX: shake,
		tilt: -shake * 1.6,
		squash: Math.abs(shake) * 0.4,
	};
}

/** `startled`: an instant jump that wobbles back down, eyes blown wide. */
function startledParams(elapsed: number): PetParams {
	const decay = Math.exp(-elapsed / 190);
	return {
		blinkK: EYE_OPEN,
		eyeScale: 1 + 0.3 * decay,
		bobY: -0.062 * decay * Math.cos((elapsed / 260) * Math.PI * 2),
		squash: -0.05 * decay,
		tilt: 0.04 * decay * Math.sin((elapsed / 180) * Math.PI * 2),
	};
}
