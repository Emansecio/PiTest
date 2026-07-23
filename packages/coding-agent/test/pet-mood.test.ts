import { describe, expect, test } from "vitest";
import { PET_MOOD_TIMINGS, PetMood } from "../src/modes/interactive/components/pet-mood.ts";

const OPEN = 1;
const CLOSED = 0.08;

/** rng that always returns 0 → idle blink lands at exactly `now + idleBlinkMinMs`. */
const rngZero = () => 0;

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

	test("thinking half-closes the eyes and sweeps horizontally", () => {
		const mood = new PetMood({ now: 1000, rng: rngZero });
		mood.setState("thinking", 1000);
		expect(mood.params(1000).blinkK).toBe(0.75);
		// A quarter of the 2s period in reaches the sweep's positive extreme.
		const quarter = mood.params(1000 + 500).eyeShift ?? 0;
		expect(quarter).toBeGreaterThan(0.06);
		// Centered again at the sweep's start.
		expect(mood.params(1000).eyeShift ?? 0).toBeCloseTo(0, 5);
	});

	test("working sweeps faster than thinking", () => {
		const think = new PetMood({ now: 0, rng: rngZero });
		think.setState("thinking", 0);
		const work = new PetMood({ now: 0, rng: rngZero });
		work.setState("working", 0);
		// After 200ms, working (0.8s period) has advanced further into its cycle
		// than thinking (2s period) — a strictly larger absolute gaze offset.
		const t = Math.abs(think.params(200).eyeShift ?? 0);
		const w = Math.abs(work.params(200).eyeShift ?? 0);
		expect(w).toBeGreaterThan(t);
		expect(work.params(0).blinkK).toBe(0.82);
	});
});

describe("PetMood transient moods", () => {
	test("done plays a double-blink then auto-returns to idle", () => {
		const mood = new PetMood({ now: 0, rng: rngZero });
		mood.setState("done", 0);
		const seg = PET_MOOD_TIMINGS.doneMs / 4;
		// closed · open · closed · open across the four segments.
		expect(mood.params(seg * 0.5).blinkK).toBe(CLOSED);
		expect(mood.params(seg * 1.5).blinkK).toBe(OPEN);
		expect(mood.params(seg * 2.5).blinkK).toBe(CLOSED);
		expect(mood.params(seg * 3.5).blinkK).toBe(OPEN);
		// Not yet elapsed → still done.
		expect(mood.tick(PET_MOOD_TIMINGS.doneMs - 1)).toBe(false);
		expect(mood.current).toBe("done");
		// Elapsed → auto-transition to idle.
		expect(mood.tick(PET_MOOD_TIMINGS.doneMs)).toBe(true);
		expect(mood.current).toBe("idle");
	});

	test("error shakes horizontally (eyes open) then auto-returns to idle", () => {
		const mood = new PetMood({ now: 0, rng: rngZero });
		mood.setState("error", 0);
		// A quarter into the first oscillation reaches the shake's extreme; eyes stay open.
		const p = mood.params(PET_MOOD_TIMINGS.errorMs / 8);
		expect(Math.abs(p.eyeShift ?? 0)).toBeGreaterThan(0.1);
		expect(p.blinkK).toBe(OPEN);
		expect(mood.tick(PET_MOOD_TIMINGS.errorMs - 1)).toBe(false);
		expect(mood.current).toBe("error");
		expect(mood.tick(PET_MOOD_TIMINGS.errorMs)).toBe(true);
		expect(mood.current).toBe("idle");
	});
});

describe("PetMood idle blink", () => {
	test("blinks at the scheduled time, then reschedules", () => {
		const mood = new PetMood({ now: 0, rng: rngZero });
		const at = PET_MOOD_TIMINGS.idleBlinkMinMs; // rng=0 → min delay
		// Before the blink window: eyes open.
		expect(mood.params(at - 1).blinkK).toBe(OPEN);
		// Inside the window: eyes shut.
		expect(mood.params(at + 10).blinkK).toBe(CLOSED);
		// After the window closes, tick reschedules and the eyes reopen.
		mood.tick(at + PET_MOOD_TIMINGS.blinkDurationMs);
		expect(mood.params(at + PET_MOOD_TIMINGS.blinkDurationMs).blinkK).toBe(OPEN);
		// Next blink is a full cadence later, not immediately.
		expect(mood.params(at + PET_MOOD_TIMINGS.blinkDurationMs + 100).blinkK).toBe(OPEN);
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

	test("done and error collapse to idle", () => {
		const mood = new PetMood({ now: 0, reducedMotion: true, rng: rngZero });
		mood.setState("done", 0);
		expect(mood.current).toBe("idle");
		mood.setState("error", 0);
		expect(mood.current).toBe("idle");
	});
});
