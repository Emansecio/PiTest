import { type PetColors, visibleWidth } from "@pit/tui";
import { describe, expect, test } from "vitest";
import {
	createPetCompanion,
	PET_COMPANION_COLS,
	PET_COMPANION_ROWS,
} from "../src/modes/interactive/components/pet-companion.ts";

const COLORS: PetColors = {
	bg: [10, 11, 14],
	stroke: [240, 240, 245],
	eye: [63, 224, 122],
};

function makeClock() {
	const state = { now: 0 };
	return { clock: () => state.now, state };
}

describe("PetCompanion render", () => {
	test("renders exactly ROWS lines, each clamped to the pet's column footprint", () => {
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		const lines = pet.render(PET_COMPANION_COLS);
		expect(lines).toHaveLength(PET_COMPANION_ROWS);
		for (const line of lines) expect(visibleWidth(line)).toBe(PET_COMPANION_COLS);
	});

	test("clamps to the pet width even when handed a wider gutter", () => {
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		const lines = pet.render(PET_COMPANION_COLS + 4);
		for (const line of lines) expect(visibleWidth(line)).toBe(PET_COMPANION_COLS);
	});

	test("draws half-block glyphs for the mascot body", () => {
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		const joined = pet.render(PET_COMPANION_COLS).join("\n");
		expect(joined.includes("▀") || joined.includes("▄")).toBe(true);
	});

	test("memoizes: identical params hand back the same array reference", () => {
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		expect(pet.render(PET_COMPANION_COLS)).toBe(pet.render(PET_COMPANION_COLS));
	});

	test("re-renders when the mood changes the eyes", () => {
		const { clock, state } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		const idle = pet.render(PET_COMPANION_COLS);
		pet.setMood("thinking", 0);
		state.now = 500; // a quarter into the sweep — eyes shifted
		const thinking = pet.render(PET_COMPANION_COLS);
		expect(thinking).not.toBe(idle);
	});
});

describe("PetCompanion reduced motion", () => {
	test("stays static (same frame) regardless of clock or mood", () => {
		const { clock, state } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock, reducedMotion: true });
		const a = pet.render(PET_COMPANION_COLS);
		pet.setMood("thinking", 0);
		state.now = 9999;
		const b = pet.render(PET_COMPANION_COLS);
		expect(b).toBe(a);
	});

	test("tick never requests a repaint", () => {
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock, reducedMotion: true });
		pet.setMood("thinking", 0);
		expect(pet.tick(0)).toBe(false);
		expect(pet.tick(5000)).toBe(false);
	});
});

describe("PetCompanion mood driving", () => {
	test("setMood reflects in moodState", () => {
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		expect(pet.moodState).toBe("idle");
		pet.setMood("thinking", 0);
		expect(pet.moodState).toBe("thinking");
		pet.setMood("working", 0);
		expect(pet.moodState).toBe("working");
	});

	test("tick advances a done mood back to idle once its window elapses", () => {
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		pet.setMood("done", 0);
		expect(pet.moodState).toBe("done");
		pet.tick(1000); // past the done window
		expect(pet.moodState).toBe("idle");
	});
});
