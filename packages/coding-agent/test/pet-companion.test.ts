import {
	type PetColors,
	resetCellDimensions,
	resetSixelSupport,
	SIXEL_INTRO,
	setCellDimensions,
	setSixelSupport,
	visibleWidth,
} from "@pit/tui";
import { afterEach, describe, expect, test } from "vitest";
import {
	createPetCompanion,
	PET_PERCH_CELL_COLS,
	PET_PERCH_CELL_ROWS,
	PET_PERCH_SIXEL_DRAW_ROWS,
	PET_PERCH_SIXEL_ROWS,
} from "../src/modes/interactive/components/pet-companion.ts";
import { petFrameIntervalMs } from "../src/modes/interactive/components/pet-mood.ts";

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

/**
 * The perch is the one place a sixel is emitted at the BOTTOM of the screen, one
 * row above the editor. A sprite that draws past its reservation reaches the last
 * screen row, the terminal scrolls to make space, and the differential renderer —
 * which cannot observe a terminal-side scroll — spends the rest of the session
 * repainting every live line one row lower than the last (the stacked-"Thinking…"
 * corruption). Both guards below exist to make that unreachable.
 */
describe("PetCompanion perch — sixel", () => {
	const CELL = { widthPx: 10, heightPx: 20 };
	afterEach(() => {
		resetSixelSupport();
		resetCellDimensions();
	});

	/** Height in pixels the emitted sixel declares in its raster attributes. */
	function declaredHeightPx(line: string): number {
		const match = line.match(/"1;1;(\d+);(\d+)/);
		if (!match) throw new Error("no sixel raster attributes on the perch line");
		return parseInt(match[2]!, 10);
	}

	test("reserves PET_PERCH_SIXEL_ROWS rows with the sprite on a trailing image line", () => {
		setSixelSupport(true);
		setCellDimensions(CELL);
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		const lines = pet.render(WIDTH);
		expect(lines).toHaveLength(PET_PERCH_SIXEL_ROWS);
		// Leading reserved rows are blank; the final row carries the self-clearing sixel.
		for (const line of lines.slice(0, -1)) expect(line).toBe("");
		expect(lines.at(-1)!.includes(SIXEL_INTRO)).toBe(true);
	});

	test("the sprite leaves a spare row: drawn height fits with a full row to spare", () => {
		setSixelSupport(true);
		setCellDimensions(CELL);
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		const heightPx = declaredHeightPx(pet.render(WIDTH).at(-1)!);
		expect(heightPx).toBeLessThanOrEqual(PET_PERCH_SIXEL_DRAW_ROWS * CELL.heightPx);
		expect(PET_PERCH_SIXEL_ROWS * CELL.heightPx - heightPx).toBeGreaterThanOrEqual(CELL.heightPx);
	});

	/**
	 * The reservation is in rows, the drawing is in pixels, and the conversion is
	 * only exact when the cell height happens to be a multiple of the 6px band. A
	 * 20px cell is (3 × 20 = 60 = ten bands), which is why the fixed-cell tests
	 * above never saw the gap. Real cells are mostly NOT that: 17px asks for 51px,
	 * which a terminal rounding to whole bands serves as 54px — past the perch, into
	 * the editor, and at the bottom of the screen into a scroll nobody can observe.
	 */
	test("fits its reservation for every plausible cell height, band rounding included", () => {
		const BAND = 6;
		for (const heightPx of [6, 7, 8, 11, 13, 16, 17, 18, 19, 20, 23, 24, 29, 32, 37, 40, 48, 64]) {
			setSixelSupport(true);
			setCellDimensions({ widthPx: Math.max(3, Math.round(heightPx * 0.5)), heightPx });
			const { clock } = makeClock();
			const pet = createPetCompanion({ getColors: () => COLORS, clock });
			const lines = pet.render(WIDTH);

			expect(lines, `cell ${heightPx}px: reservation must not change`).toHaveLength(PET_PERCH_SIXEL_ROWS);
			const declared = declaredHeightPx(lines.at(-1)!);
			const bandRounded = Math.ceil(declared / BAND) * BAND;
			// The load-bearing assertion: even rounded up to whole bands, the drawing
			// stays inside the rows the sprite is allowed to touch.
			expect(bandRounded, `cell ${heightPx}px: band-rounded ${bandRounded}px`).toBeLessThanOrEqual(
				PET_PERCH_SIXEL_DRAW_ROWS * heightPx,
			);
			// And the slack row below it is still slack.
			expect(PET_PERCH_SIXEL_ROWS * heightPx - bandRounded).toBeGreaterThanOrEqual(heightPx);
			resetCellDimensions();
		}
	});

	test("self-erase paints blank text over the sprite's full footprint, not just EL", () => {
		// xterm leaves sixel pixels displayed over an `\x1b[2K`-erased line (only ED,
		// whole-line ops, or WRITTEN text erase graphics), and with the transparent
		// P2=1 palette the next frame's untouched pixels kept the PREVIOUS pose —
		// the body animations accumulated silhouettes. The choreography must repaint
		// blank TEXT across the sprite's column span on every reserved row.
		setSixelSupport(true);
		setCellDimensions(CELL); // 10×20px → sprite 60px tall, 120px wide
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		const line = pet.render(WIDTH).at(-1)!;
		// One erase run per reserved row: EL + petCols blanks + CUB back to the
		// sprite's left edge (cursor choreography keeps the DCS anchored).
		const petCols = 12; // ceil(fitSixelHeightPx(3*20) * 2 / 10)
		const run = `\x1b[2K${" ".repeat(petCols)}\x1b[${petCols}D`;
		expect(line).toContain(`${run}${`\x1b[1A${run}`.repeat(PET_PERCH_SIXEL_ROWS - 1)}`);
		expect(line.endsWith("\x1b8")).toBe(true); // DECRC still pins the cursor at the end
	});

	test("stays on cells until the terminal reports its cell size", () => {
		setSixelSupport(true); // capability yes — measurement no
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		const lines = pet.render(WIDTH);
		expect(lines).toHaveLength(PET_PERCH_CELL_ROWS);
		expect(lines.join("").includes(SIXEL_INTRO)).toBe(false);
	});

	test("upgrades to sixel once the cell size lands", () => {
		setSixelSupport(true);
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		expect(pet.render(WIDTH)).toHaveLength(PET_PERCH_CELL_ROWS);
		setCellDimensions(CELL);
		expect(pet.render(WIDTH)).toHaveLength(PET_PERCH_SIXEL_ROWS);
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

	test("an ambient mood yields to a live turn but takes over at rest", () => {
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		// At rest: a keystroke makes the pet lean in.
		pet.setAmbientMood("watching", 0);
		expect(pet.moodState).toBe("watching");
		// Mid-turn: typing must not pull it out of the work mood.
		pet.setMood("working", 0);
		pet.setAmbientMood("watching", 10);
		expect(pet.moodState).toBe("working");
	});

	/**
	 * Ambient signals only arrive on editor input. A draft typed BEFORE a turn is
	 * still standing there when the turn ends, so settling on `idle` leaves the pet
	 * upright over text it is supposed to be leaning toward — until the user
	 * happens to press another key.
	 */
	test("a standing draft survives the turn: done settles back into watching", () => {
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		pet.setAmbientMood("watching", 0);
		pet.setMood("working", 10);
		pet.setMood("done", 20);
		pet.tick(1000); // past the done window
		expect(pet.moodState).toBe("watching");
	});

	test("an empty composer settles on idle, as before", () => {
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		pet.setAmbientMood("watching", 0);
		pet.setAmbientMood("idle", 5); // the user cleared the draft
		pet.setMood("done", 20);
		pet.tick(1000);
		expect(pet.moodState).toBe("idle");
	});

	test("the restored baseline can still doze off", () => {
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		pet.setAmbientMood("watching", 0);
		pet.setMood("done", 20);
		pet.tick(1000);
		expect(pet.moodState).toBe("watching");
		pet.tick(1000 + 200_000); // long past the sleep threshold
		expect(pet.moodState).toBe("sleepy");
	});
});

describe("PetCompanion frame gate", () => {
	/** rng 0.9: next blink at 7220ms, next glance at 6440ms — a 4.2s breath, undisturbed. */
	const rngHigh = () => 0.9;

	test("idle breathing repaints once per sample interval, not once per breath", () => {
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock, rng: rngHigh });
		pet.tick(0); // prime the frame key
		let dirty = 0;
		const step = petFrameIntervalMs("idle");
		const frames = Math.floor(4200 / step); // one full breath
		for (let i = 1; i <= frames; i++) if (pet.tick(i * step)) dirty += 1;
		// The sample clock is the ONLY rate limiter. Pixel-bucketing the pose used to
		// cap this at a couple of crossings per breath, which measured 2.5 repaints/s
		// with stalls up to 1.36s — a pet that held still and then jumped.
		expect(dirty).toBe(frames);
	});

	test("the 16ms ticker does not repaint faster than the mood's cadence", () => {
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock, rng: rngHigh });
		pet.tick(0);
		let dirty = 0;
		for (let t = 16; t <= 4000; t += 16) if (pet.tick(t)) dirty += 1;
		// 4s of idle at a 50ms interval — the quantized sample, not the ticker, sets
		// the pace. A few frames of slack for buckets that land on identical poses.
		const expected = 4000 / petFrameIntervalMs("idle");
		expect(dirty).toBeLessThanOrEqual(expected);
		expect(dirty).toBeGreaterThan(expected * 0.9);
	});

	test("a pose that does not move never repaints", () => {
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock, rng: rngHigh, reducedMotion: true });
		pet.tick(0);
		let dirty = 0;
		for (let t = 16; t <= 4000; t += 16) if (pet.tick(t)) dirty += 1;
		expect(dirty).toBe(0);
	});

	test("a scheduled blink still repaints (governed motion is quantized, never dropped)", () => {
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock, rng: rngHigh });
		pet.tick(7000); // prime, well before the 7220ms blink
		// Inside the blink ramp (85ms in of 170ms) the eyes are visibly closing.
		expect(pet.tick(7305)).toBe(true);
	});

	test("working still moves at full fidelity", () => {
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock, rng: rngHigh });
		pet.setMood("working", 0);
		pet.tick(0);
		let dirty = 0;
		for (let t = 40; t <= 800; t += 40) if (pet.tick(t)) dirty += 1; // one full sweep+hop cycle
		expect(dirty).toBeGreaterThanOrEqual(4);
	});
});

describe("PetCompanion frame governor", () => {
	test("ticks inside one repaint slot report no change", () => {
		const { clock } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		pet.setMood("thinking", 0);
		// First tick primes the frame key; the next one lands in the same 60ms
		// slot, so the sweep is sampled at the same instant → nothing to repaint.
		pet.tick(0);
		expect(pet.tick(16)).toBe(false);
		expect(pet.tick(32)).toBe(false);
		// The next slot samples a new frame of the sweep.
		expect(pet.tick(60)).toBe(true);
	});

	test("renders the same sprite for two clocks in the same slot", () => {
		setSixelSupport(false);
		const { clock, state } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		pet.setMood("thinking", 0);
		const a = pet.render(WIDTH);
		state.now = 20; // same 60ms slot
		expect(pet.render(WIDTH)).toBe(a);
		state.now = 300; // several slots later — the sweep moved on
		expect(pet.render(WIDTH)).not.toBe(a);
		resetSixelSupport();
	});
});

describe("PetCompanion body animation", () => {
	test("a mood that only moves the body still repaints", () => {
		setSixelSupport(false);
		const { clock, state } = makeClock();
		const pet = createPetCompanion({ getColors: () => COLORS, clock });
		const resting = pet.render(WIDTH);
		// `startled` never touches blinkK — if the body channels were dropped on
		// the way to the renderer, this frame would be byte-identical.
		pet.setMood("startled", 0);
		state.now = 33;
		expect(pet.render(WIDTH)).not.toBe(resting);
		resetSixelSupport();
	});
});
