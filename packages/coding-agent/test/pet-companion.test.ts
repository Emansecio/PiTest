import { type PetColors, resetSixelSupport, SIXEL_INTRO, setSixelSupport, visibleWidth } from "@pit/tui";
import { afterEach, describe, expect, test } from "vitest";
import {
	createPetCompanion,
	PET_PERCH_CELL_COLS,
	PET_PERCH_CELL_ROWS,
	PET_PERCH_SIXEL_ROWS,
} from "../src/modes/interactive/components/pet-companion.ts";

const COLORS: PetColors = {
	bg: [10, 11, 14],
	stroke: [240, 240, 245],
	eye: [63, 224, 122],
};

/** Composer width the perch renders across (well over PET_COMPANION_MIN_COLS). */
const WIDTH = 120;

function makeClock() {
	const state = { now: 0 };
	return { clock: () => state.now, state };
}

describe("PetCompanion perch — cell fallback", () => {
	afterEach(() => resetSixelSupport());

	test("renders PET_PERCH_CELL_ROWS lines, each spanning the full perch width", () => {
		setSixelSupport(false);
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		const lines = pet.render(WIDTH);
		expect(lines).toHaveLength(PET_PERCH_CELL_ROWS);
		for (const line of lines) expect(visibleWidth(line)).toBe(WIDTH);
	});

	test("right-aligns the sprite (left columns are plain padding)", () => {
		setSixelSupport(false);
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		const lines = pet.render(WIDTH);
		// Everything left of the sprite is unstyled spaces — the pet sits at the right edge.
		for (const line of lines) expect(line.startsWith(" ".repeat(WIDTH - PET_PERCH_CELL_COLS))).toBe(true);
	});

	test("draws half-block glyphs for the mascot body", () => {
		setSixelSupport(false);
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		const joined = pet.render(WIDTH).join("\n");
		expect(joined.includes("▀") || joined.includes("▄")).toBe(true);
	});

	test("memoizes: identical params hand back the same array reference", () => {
		setSixelSupport(false);
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		expect(pet.render(WIDTH)).toBe(pet.render(WIDTH));
	});

	test("re-renders when the mood changes the eyes", () => {
		setSixelSupport(false);
		const { clock, state } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		const idle = pet.render(WIDTH);
		pet.setMood("thinking", 0);
		state.now = 500; // a quarter into the sweep — eyes shifted
		const thinking = pet.render(WIDTH);
		expect(thinking).not.toBe(idle);
	});
});

describe("PetCompanion perch — sixel", () => {
	afterEach(() => resetSixelSupport());

	test("reserves PET_PERCH_SIXEL_ROWS rows with the sprite on a trailing image line", () => {
		setSixelSupport(true);
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		const lines = pet.render(WIDTH);
		expect(lines).toHaveLength(PET_PERCH_SIXEL_ROWS);
		// Leading reserved rows are blank; the final row carries the self-clearing sixel.
		for (const line of lines.slice(0, -1)) expect(line).toBe("");
		expect(lines.at(-1)!.includes(SIXEL_INTRO)).toBe(true);
	});
});

describe("PetCompanion reduced motion", () => {
	afterEach(() => resetSixelSupport());

	test("stays static (same frame) regardless of clock or mood", () => {
		setSixelSupport(false);
		const { clock, state } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock, reducedMotion: true });
		const a = pet.render(WIDTH);
		pet.setMood("thinking", 0);
		state.now = 9999;
		const b = pet.render(WIDTH);
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
