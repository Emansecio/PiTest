import { petCoverage } from "@pit/tui";
import { describe, expect, test } from "vitest";
import {
	CROSSFADE_MS,
	PET_MOOD_TIMINGS,
	PetMood,
	type PetMoodState,
	petFrameIntervalMs,
} from "../src/modes/interactive/components/pet-mood.ts";

const OPEN = 1;
const CLOSED = 0.08;
/** Sample past the mood crossfade so assertions see pure target params. */
const AFTER_CF = CROSSFADE_MS + 1;

/** rng floor: blink scheduled at exactly `now + idleBlinkMinMs`, as a DOUBLE blink. */
const rngZero = () => 0;
/** rng high: single blink (0.9 ≥ the double-blink chance), latest cadence slot. */
const rngHigh = () => 0.9;

/** Peak of a blink whose window opens at `at` — the closed extreme of the ramp. */
function blinkPeak(at: number): number {
	return at + PET_MOOD_TIMINGS.blinkDurationMs / 2;
}

describe("PetMood transitions", () => {
	test("starts idle with eyes open", () => {
		const mood = new PetMood({ now: 0, rng: rngZero });
		expect(mood.current).toBe("idle");
		expect(mood.params(0).blinkK).toBe(OPEN);
		expect(mood.params(0).eyeShift ?? 0).toBe(0);
	});

	test("setState reports whether the mood actually changed", () => {
		const mood = new PetMood({ now: 0, rng: rngZero });
		expect(mood.setState("thinking", 100)).toBe(true);
		expect(mood.setState("thinking", 200)).toBe(false);
		expect(mood.current).toBe("thinking");
	});

	test("thinking half-closes the eyes, sweeps, and leans the head into the sweep", () => {
		const mood = new PetMood({ now: 1000, rng: rngZero });
		mood.setState("thinking", 1000);
		// After the crossfade, base thinking lids (open-eye micro-blink factor = 1).
		expect(mood.params(1000 + AFTER_CF).blinkK).toBeCloseTo(0.75, 5);
		// A quarter of the 2s period in reaches the sweep's positive extreme.
		const p = mood.params(1000 + 500);
		expect(p.eyeShift ?? 0).toBeGreaterThan(0.06);
		// The tilt follows the gaze — same sign, not an independent wobble.
		expect(Math.sign(p.tilt ?? 0)).toBe(Math.sign(p.eyeShift ?? 0));
		// Still near the sweep origin just after enter (past crossfade).
		expect(Math.abs(mood.params(1000 + AFTER_CF).eyeShift ?? 0)).toBeLessThan(0.03);
	});

	test("working sweeps faster than thinking and hops the body", () => {
		const think = new PetMood({ now: 0, rng: rngZero });
		think.setState("thinking", 0);
		const work = new PetMood({ now: 0, rng: rngZero });
		work.setState("working", 0);
		// After 200ms, working (0.8s period) has advanced further into its cycle
		// than thinking (2s period) — a strictly larger absolute gaze offset.
		const t = Math.abs(think.params(200).eyeShift ?? 0);
		const w = Math.abs(work.params(200).eyeShift ?? 0);
		expect(w).toBeGreaterThan(t);
		expect(work.params(AFTER_CF).blinkK).toBe(0.82);
		// Mid-hop the whole body is off the ground (negative = lifted).
		expect(work.params(210).bobY ?? 0).toBeLessThan(-0.02);
		// Grounded between hops, and squashed rather than stretched there.
		expect(work.params(420).bobY ?? 0).toBeCloseTo(0, 5);
		expect(work.params(420).squash ?? 0).toBeGreaterThan(0);
	});

	test("digesting circles the gaze (x and y a quarter-cycle apart)", () => {
		const mood = new PetMood({ now: 0, rng: rngZero });
		mood.setState("digesting", 0);
		// Pure digesting pose after the enter crossfade (still near circle start).
		const start = mood.params(AFTER_CF);
		expect(start.eyeShift ?? 0).toBeGreaterThan(0.05);
		expect(Math.abs(start.eyeShiftY ?? 0)).toBeLessThan(0.03);
		const quarter = mood.params(450); // a quarter of the 1800ms circle
		expect(quarter.eyeShift ?? 0).toBeCloseTo(0, 5);
		expect(quarter.eyeShiftY ?? 0).toBeGreaterThan(0.04);
	});

	test("waiting looks up with half-lidded eyes", () => {
		const mood = new PetMood({ now: 0, rng: rngHigh });
		mood.setState("waiting", 0);
		const p = mood.params(AFTER_CF);
		expect(p.eyeShiftY ?? 0).toBeLessThan(0); // negative = looking up
		expect(p.blinkK).toBeLessThan(0.6);
	});

	test("alert widens the eyes and holds the body still", () => {
		const mood = new PetMood({ now: 0, rng: rngHigh });
		mood.setState("alert", 0);
		const p = mood.params(AFTER_CF);
		expect(p.eyeScale ?? 1).toBeGreaterThan(1.1);
		expect(p.tilt ?? 0).toBe(0);
		expect(Math.abs(p.bobY ?? 0)).toBeLessThan(0.02);
	});

	test("watching leans in and looks down at the composer", () => {
		const mood = new PetMood({ now: 0, rng: rngHigh });
		mood.setState("watching", 0);
		const p = mood.params(AFTER_CF);
		expect(p.eyeShiftY ?? 0).toBeGreaterThan(0); // positive = looking down
		expect(p.tilt ?? 0).toBeLessThan(0);
	});
});

describe("PetMood idle life", () => {
	test("breathes: the body rises and falls over the breath period", () => {
		const mood = new PetMood({ now: 0, rng: rngHigh });
		const { breathPeriodMs } = PET_MOOD_TIMINGS;
		expect(mood.params(0).bobY ?? 0).toBeCloseTo(0, 5);
		const up = mood.params(breathPeriodMs / 4).bobY ?? 0;
		const down = mood.params((breathPeriodMs * 3) / 4).bobY ?? 0;
		expect(up).toBeGreaterThan(0.015);
		expect(down).toBeLessThan(-0.015);
		// Stretch runs against the bob — the classic breathing squash.
		expect(Math.sign(mood.params(breathPeriodMs / 4).squash ?? 0)).toBe(-Math.sign(up));
	});

	test("blinks at the scheduled time as a smooth close/open, then reschedules", () => {
		const mood = new PetMood({ now: 0, rng: rngHigh });
		const at =
			PET_MOOD_TIMINGS.idleBlinkMinMs + 0.9 * (PET_MOOD_TIMINGS.idleBlinkMaxMs - PET_MOOD_TIMINGS.idleBlinkMinMs);
		// Before the blink window: eyes open.
		expect(mood.params(at - 1).blinkK).toBe(OPEN);
		// The ramp bottoms out at the middle of the window.
		expect(mood.params(blinkPeak(at)).blinkK).toBeCloseTo(CLOSED, 5);
		// Partway in it is on its way down, not snapped shut.
		const partial = mood.params(at + 40).blinkK;
		expect(partial).toBeGreaterThan(CLOSED);
		expect(partial).toBeLessThan(OPEN);
		// After the window closes, tick reschedules and the eyes stay open.
		mood.tick(at + PET_MOOD_TIMINGS.blinkDurationMs);
		expect(mood.params(at + PET_MOOD_TIMINGS.blinkDurationMs).blinkK).toBe(OPEN);
		expect(mood.params(at + PET_MOOD_TIMINGS.blinkDurationMs + 100).blinkK).toBe(OPEN);
	});

	test("a double blink flashes twice with eyes open between", () => {
		const { blinkDurationMs, doubleBlinkGapMs, idleBlinkMinMs } = PET_MOOD_TIMINGS;
		// rng = 0 → double blink, scheduled at the minimum cadence.
		const mood = new PetMood({ now: 0, rng: rngZero });
		expect(mood.params(blinkPeak(idleBlinkMinMs)).blinkK).toBeCloseTo(CLOSED, 5);
		expect(mood.params(idleBlinkMinMs + blinkDurationMs + doubleBlinkGapMs / 2).blinkK).toBe(OPEN);
		const second = idleBlinkMinMs + blinkDurationMs + doubleBlinkGapMs;
		expect(mood.params(blinkPeak(second)).blinkK).toBeCloseTo(CLOSED, 5);
	});

	test("glances to the side and leans the head the other way, then recenters", () => {
		// rng = 0 → glance at `saccadeMinMs`, to the left (x < 0).
		const mood = new PetMood({ now: 0, rng: rngZero });
		const at = PET_MOOD_TIMINGS.saccadeMinMs;
		expect(mood.params(at - 1).eyeShift ?? 0).toBe(0);
		const held = mood.params(at + PET_MOOD_TIMINGS.saccadeDurationMs / 2);
		expect(held.eyeShift ?? 0).toBeLessThan(-0.04);
		expect(held.tilt ?? 0).toBeGreaterThan(0);
		// The glance ends, and tick schedules the next one.
		expect(mood.params(at + PET_MOOD_TIMINGS.saccadeDurationMs).eyeShift ?? 0).toBe(0);
	});

	test("dozes off after a long idle and breathes deeper asleep", () => {
		const mood = new PetMood({ now: 0, rng: rngHigh });
		expect(mood.tick(PET_MOOD_TIMINGS.sleepAfterMs - 1)).toBe(false);
		expect(mood.current).toBe("idle");
		expect(mood.tick(PET_MOOD_TIMINGS.sleepAfterMs)).toBe(true);
		expect(mood.current).toBe("sleepy");
		// Lids down (after the idle→sleepy crossfade)…
		expect(mood.params(PET_MOOD_TIMINGS.sleepAfterMs + AFTER_CF).blinkK).toBeLessThan(0.3);
		// …and a bigger, slower breath than when awake.
		const asleep = Math.abs(mood.params(PET_MOOD_TIMINGS.sleepAfterMs + 1400).bobY ?? 0);
		const awake = new PetMood({ now: 0, rng: rngHigh });
		const awakeBob = Math.abs(awake.params(PET_MOOD_TIMINGS.breathPeriodMs / 4).bobY ?? 0);
		expect(asleep).toBeGreaterThan(awakeBob);
	});

	test("dozes off over a composer left half-typed, but not while it is being typed into", () => {
		const { sleepAfterMs } = PET_MOOD_TIMINGS;
		const mood = new PetMood({ now: 0, rng: rngHigh });
		mood.setState("watching", 0);
		// Still typing at the last moment → the countdown restarts.
		mood.keepAwake(sleepAfterMs - 10);
		expect(mood.tick(sleepAfterMs)).toBe(false);
		expect(mood.current).toBe("watching");
		// Left alone for a full window → it nods off over the unsent text.
		expect(mood.tick(sleepAfterMs * 2)).toBe(true);
		expect(mood.current).toBe("sleepy");
	});

	test("a mood change wakes the pet and restarts its ambient schedules", () => {
		const mood = new PetMood({ now: 0, rng: rngHigh });
		mood.tick(PET_MOOD_TIMINGS.sleepAfterMs);
		expect(mood.current).toBe("sleepy");
		mood.setState("thinking", PET_MOOD_TIMINGS.sleepAfterMs);
		expect(mood.current).toBe("thinking");
		// Back to idle: the sleep countdown starts over, it does not doze instantly.
		mood.setState("idle", PET_MOOD_TIMINGS.sleepAfterMs + 10);
		expect(mood.tick(PET_MOOD_TIMINGS.sleepAfterMs + 20)).toBe(false);
		expect(mood.current).toBe("idle");
	});
});

describe("PetMood transient moods", () => {
	test("done hops, lands with a squash, then auto-returns to idle", () => {
		const mood = new PetMood({ now: 0, rng: rngZero });
		mood.setState("done", 0);
		// Airborne mid-hop: lifted and stretched.
		const air = mood.params(210);
		expect(air.bobY ?? 0).toBeLessThan(-0.05);
		expect(air.squash ?? 0).toBeLessThan(0);
		// Landing: back down and squashed.
		const land = mood.params(450);
		expect(land.bobY ?? 0).toBeGreaterThan(0);
		expect(land.squash ?? 0).toBeGreaterThan(0);
		// It blinks on the way up.
		expect(mood.params(120).blinkK).toBeLessThan(0.5);
		// Not yet elapsed → still done.
		expect(mood.tick(PET_MOOD_TIMINGS.doneMs - 1)).toBe(false);
		expect(mood.current).toBe("done");
		// Elapsed → auto-transition to idle.
		expect(mood.tick(PET_MOOD_TIMINGS.doneMs)).toBe(true);
		expect(mood.current).toBe("idle");
	});

	test("error shakes the whole body (damped, eyes wide) then auto-returns to idle", () => {
		const mood = new PetMood({ now: 0, rng: rngZero });
		mood.setState("error", 0);
		// A quarter into the first oscillation reaches the shake's extreme.
		const p = mood.params(PET_MOOD_TIMINGS.errorMs / 8);
		expect(Math.abs(p.bobX ?? 0)).toBeGreaterThan(0.03);
		expect(p.blinkK).toBe(OPEN);
		expect(p.eyeScale ?? 1).toBeGreaterThan(1);
		// The head rolls against the shake, and the motion damps out.
		expect(Math.sign(p.tilt ?? 0)).toBe(-Math.sign(p.bobX ?? 0));
		const late = Math.abs(mood.params((PET_MOOD_TIMINGS.errorMs * 5) / 8).bobX ?? 0);
		expect(late).toBeLessThan(Math.abs(p.bobX ?? 0));
		expect(mood.tick(PET_MOOD_TIMINGS.errorMs - 1)).toBe(false);
		expect(mood.current).toBe("error");
		expect(mood.tick(PET_MOOD_TIMINGS.errorMs)).toBe(true);
		expect(mood.current).toBe("idle");
	});

	test("startled jumps immediately, wobbles out, then auto-returns to idle", () => {
		const mood = new PetMood({ now: 0, rng: rngZero });
		mood.setState("startled", 0);
		// Pure startled after enter crossfade: still elevated eyes and a live wobble.
		const first = mood.params(AFTER_CF);
		expect(first.eyeScale ?? 1).toBeGreaterThan(1.15);
		expect(Math.abs(first.bobY ?? 0)).toBeGreaterThan(0.02);
		// Damped: the late wobble is far smaller than the early jump.
		expect(Math.abs(mood.params(400).bobY ?? 0)).toBeLessThan(Math.abs(first.bobY ?? 0) / 2);
		expect(mood.tick(PET_MOOD_TIMINGS.startledMs - 1)).toBe(false);
		expect(mood.current).toBe("startled");
		expect(mood.tick(PET_MOOD_TIMINGS.startledMs)).toBe(true);
		expect(mood.current).toBe("idle");
	});
});

describe("PetMood crossfade", () => {
	test("idle→thinking params shortly after setState sit between the two moods", () => {
		const mood = new PetMood({ now: 0, rng: rngHigh });
		const idleBlink = mood.params(0).blinkK;
		mood.setState("thinking", 0);
		// Mid-crossfade: lids are partway from idle open toward thinking half-lid.
		const mid = mood.params(CROSSFADE_MS / 2);
		expect(mid.blinkK).toBeGreaterThan(0.75);
		expect(mid.blinkK).toBeLessThan(idleBlink);
		// eyeShiftY eases from ~0 (idle) toward thinking's -0.02.
		expect(mid.eyeShiftY ?? 0).toBeLessThan(0);
		expect(mid.eyeShiftY ?? 0).toBeGreaterThan(-0.02);
	});

	test("after CROSSFADE_MS the pose matches pure thinking", () => {
		const mood = new PetMood({ now: 0, rng: rngHigh });
		mood.setState("thinking", 0);
		const settled = mood.params(AFTER_CF);
		// Open-eye micro-blink factor → pure THINKING_K.
		expect(settled.blinkK).toBeCloseTo(0.75, 5);
		expect(settled.eyeShiftY ?? 0).toBeCloseTo(-0.02, 5);
		// Further samples stay on the thinking path (no residual blend).
		const later = mood.params(500);
		expect(later.blinkK).toBeCloseTo(0.75, 5);
	});

	test("reduced motion skips the crossfade (no intermediate pose)", () => {
		const mood = new PetMood({ now: 0, reducedMotion: true, rng: rngHigh });
		mood.setState("thinking", 0);
		// Always the frozen open pose — never a blend into thinking lids.
		expect(mood.params(0).blinkK).toBe(OPEN);
		expect(mood.params(CROSSFADE_MS / 2).blinkK).toBe(OPEN);
		expect(mood.params(AFTER_CF).blinkK).toBe(OPEN);
		expect(mood.params(AFTER_CF).eyeShift ?? 0).toBe(0);
	});

	test("chained mood changes ease from the displayed blend, not pure previous", () => {
		const mood = new PetMood({ now: 0, rng: rngHigh });
		mood.setState("thinking", 0);
		// Mid idle→thinking blend.
		const midThink = mood.params(CROSSFADE_MS / 2);
		// Interrupt into working before the first crossfade finishes.
		mood.setState("working", CROSSFADE_MS / 2);
		// Immediately after: still near the interrupted mid-thinking pose, not a
		// pure-thinking or pure-working snap.
		const justAfter = mood.params(CROSSFADE_MS / 2);
		expect(justAfter.blinkK).toBeCloseTo(midThink.blinkK, 3);
		// By the end of the second crossfade, settle on working lids.
		expect(mood.params(CROSSFADE_MS / 2 + AFTER_CF).blinkK).toBeCloseTo(0.82, 5);
	});
});

describe("PetMood reduced motion", () => {
	test("stays open, ignores moods, never ticks dirty", () => {
		const mood = new PetMood({ now: 0, reducedMotion: true, rng: rngZero });
		mood.setState("thinking", 100);
		expect(mood.params(100).blinkK).toBe(OPEN);
		expect(mood.params(100).eyeShift ?? 0).toBe(0);
		expect(mood.params(999_999).blinkK).toBe(OPEN);
		expect(mood.tick(999_999)).toBe(false);
	});

	test("transient moods collapse to idle and the pet never dozes off", () => {
		const mood = new PetMood({ now: 0, reducedMotion: true, rng: rngZero });
		for (const transient of ["done", "error", "startled"] as const) {
			mood.setState(transient, 0);
			expect(mood.current).toBe("idle");
		}
		expect(mood.tick(PET_MOOD_TIMINGS.sleepAfterMs * 2)).toBe(false);
		expect(mood.current).toBe("idle");
	});
});

describe("PetMood canvas safety", () => {
	/** Every mood, sampled across its animation, must stay inside the sprite canvas. */
	test("no pose ever touches the edge of the canvas", () => {
		const moods: PetMoodState[] = [
			"idle",
			"watching",
			"thinking",
			"working",
			"digesting",
			"waiting",
			"alert",
			"done",
			"error",
			"startled",
			"sleepy",
		];
		// The canvas is x ∈ [-1, 1], y ∈ [-0.5, 0.5]; anything painted on the outer
		// ring of samples would be clipped by the sixel/cell renderers.
		const edges: Array<[number, number]> = [];
		for (let i = 0; i <= 24; i++) {
			const x = -1 + (i / 24) * 2;
			edges.push([x, -0.497], [x, 0.497]);
		}
		for (let i = 0; i <= 12; i++) {
			const y = -0.5 + (i / 12) * 1;
			edges.push([-0.995, y], [0.995, y]);
		}
		for (const state of moods) {
			const mood = new PetMood({ now: 0, rng: rngZero });
			mood.setState(state, 0);
			for (let t = 0; t <= 6000; t += 50) {
				const p = mood.params(t);
				for (const [x, y] of edges) {
					const cov = petCoverage(x, y, p);
					const painted = Math.max(cov.stroke, cov.eye);
					expect(painted, `${state} @ ${t}ms paints the canvas edge at (${x}, ${y})`).toBeLessThan(0.02);
				}
			}
		}
	});
});

describe("petFrameIntervalMs", () => {
	test("busy moods repaint at least as fast as resting ones", () => {
		// A hop is a hop: `working` and the transients share the top tier, so the
		// ladder is monotonic rather than strictly increasing at every step.
		expect(petFrameIntervalMs("done")).toBeLessThanOrEqual(petFrameIntervalMs("working"));
		expect(petFrameIntervalMs("working")).toBeLessThan(petFrameIntervalMs("thinking"));
		expect(petFrameIntervalMs("thinking")).toBeLessThan(petFrameIntervalMs("idle"));
		expect(petFrameIntervalMs("idle")).toBeLessThan(petFrameIntervalMs("sleepy"));
	});

	test("every mood stays within the 10–30 fps band the perch budget assumes", () => {
		const all: PetMoodState[] = [
			"idle",
			"watching",
			"thinking",
			"working",
			"digesting",
			"waiting",
			"alert",
			"done",
			"error",
			"startled",
			"sleepy",
		];
		for (const state of all) {
			const fps = 1000 / petFrameIntervalMs(state);
			expect(fps).toBeGreaterThanOrEqual(10);
			// ~0.5 ms per sprite encode: 30 fps is ~1.6% of a core, the agreed ceiling.
			expect(fps).toBeLessThanOrEqual(31);
		}
	});
});
