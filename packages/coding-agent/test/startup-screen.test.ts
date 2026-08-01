import { stripVTControlCharacters } from "node:util";
import {
	type PetColors,
	resetCellDimensions,
	resetSixelSupport,
	setCellDimensions,
	setSixelSupport,
	visibleWidth,
} from "@pit/tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { StartupScreen, type StartupScreenData } from "../src/modes/interactive/components/startup-screen.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	resetSixelSupport();
	resetCellDimensions();
});

const PET_COLORS: PetColors = {
	bg: [12, 14, 18],
	stroke: [233, 237, 240],
	eye: [63, 224, 122],
};

function makeData(overrides: Partial<StartupScreenData> = {}): StartupScreenData {
	return {
		appName: "pit",
		version: "0.75.4",
		tagline: "your coding companion",
		helpHint: "/help",
		recentSessions: [],
		petColors: PET_COLORS,
		petEnabled: true,
		reducedMotion: true,
		rows: 40,
		...overrides,
	};
}

const plain = (lines: string[]): string => lines.map((l) => stripVTControlCharacters(l)).join("\n");

describe("StartupScreen", () => {
	test("renders the dense identity line (no old welcome copy / rule)", () => {
		const text = plain(new StartupScreen(makeData()).render(80));
		expect(text).toContain("pit");
		expect(text).toContain("v0.75.4");
		expect(text).toContain("your coding companion");
		expect(text).not.toContain("Welcome to Pit");
		expect(text).not.toContain("/help for help");
		expect(text).not.toMatch(/─{5,}/); // no horizontal rule
	});

	// The old "workspace context accepted but NOT rendered" test is gone with the
	// fields themselves: StartupScreenData no longer carries cwd/branch/model/
	// thinking/mode at all (the pristine footer on the same screen shows them),
	// so the type system now enforces what that test asserted.

	test("renders up to three resumable recent sessions with ↳", () => {
		const data = makeData({
			recentSessions: [
				{ title: "fix terminal freeze", age: "2h" },
				{ title: "repo graph phase 4b", age: "1d" },
				{ title: "third", age: "3d" },
				{ title: "fourth (should be dropped)", age: "4d" },
			],
		});
		const text = plain(new StartupScreen(data).render(80));
		expect(text).toContain("↳ fix terminal freeze (2h)");
		expect(text).toContain("↳ repo graph phase 4b (1d)");
		expect(text).toContain("↳ third (3d)");
		expect(text).not.toContain("fourth");
	});

	test.each([18, 36, 64, 96, 120])("keeps every line inside width %i", (width) => {
		const lines = new StartupScreen(makeData({ recentSessions: [{ title: "x".repeat(200), age: "2h" }] })).render(
			width,
		);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	test("centers content within the viewport", () => {
		const lines = new StartupScreen(makeData({ recentSessions: [] })).render(80);
		const identity = lines.find((l) => stripVTControlCharacters(l).includes("pit"));
		expect(identity).toBeDefined();
		// A centered line has leading whitespace on an 80-col viewport.
		expect(identity!.startsWith(" ")).toBe(true);
	});

	test("PIT_NO_PET (petEnabled:false) drops the mascot", () => {
		const withPet = new StartupScreen(makeData({ petEnabled: true })).render(80);
		const withoutPet = new StartupScreen(makeData({ petEnabled: false })).render(80);
		// The pet block adds several lines; dropping it yields a shorter render.
		expect(withoutPet.length).toBeLessThan(withPet.length);
	});

	test("compact layout on a short window omits the big pet and top-anchors", () => {
		const compact = new StartupScreen(makeData({ rows: 12 })).render(80);
		// No leading blank top-pad, and the first non-empty line is the identity.
		const firstNonEmpty = compact.find((l) => stripVTControlCharacters(l).trim().length > 0);
		expect(stripVTControlCharacters(firstNonEmpty ?? "")).toContain("pit");
	});

	test("reduced motion renders fully settled from the first frame", () => {
		const screen = new StartupScreen(makeData({ reducedMotion: true, recentSessions: [{ title: "s", age: "1h" }] }));
		expect(screen.isSettled()).toBe(true);
		expect(screen.tick(1000)).toBe(false);
		expect(plain(screen.render(80))).toContain("↳ s (1h)");
	});

	test("staged reveal grows over time and then settles", () => {
		const screen = new StartupScreen(makeData({ reducedMotion: false, recentSessions: [{ title: "a", age: "1h" }] }));
		const firstFrame = screen.render(80).length;
		// Advance well past the full reveal + blink window.
		screen.tick(0);
		screen.tick(2000);
		const settledFrame = screen.render(80).length;
		expect(settledFrame).toBeGreaterThanOrEqual(firstFrame);
		expect(screen.isSettled()).toBe(true);
	});

	test("sixel path emits a cursor-pinned, self-clearing transparent image block", () => {
		setSixelSupport(true);
		setCellDimensions({ widthPx: 10, heightPx: 20 });
		const lines = new StartupScreen(makeData({ recentSessions: [] })).render(80);
		const petLine = lines.find((l) => l.includes("\x1bP"));
		expect(petLine).toBeDefined();
		expect(petLine).toMatch(/\x1bP0;1;0q/); // transparent sixel intro (P2=1)
		expect(petLine).toContain("\x1b7"); // DECSC save cursor
		expect(petLine).toContain("\x1b8"); // DECRC restore cursor
		expect(petLine).toContain("\x1b[2K"); // self-clear reserved rows
		expect(petLine!.endsWith("\x1b8")).toBe(true); // restore is last
	});

	/**
	 * Same invariant the composer perch is held to: the hero's reservation is in
	 * rows, the drawing is in pixels, and a terminal that rounds an image up to
	 * whole 6px bands must still land inside those rows. The hero sits at the TOP of
	 * the frame, so an overflow here does not scroll the screen the way the perch
	 * can — but it would draw over the identity block below it, and the arithmetic
	 * being right is the point either way.
	 */
	test("the hero sprite fits its reservation for every plausible cell height", () => {
		const BAND = 6;
		// PET_SIXEL_ROWS = 6, of which 5 are drawn into (one row of slack).
		const DRAW_ROWS = 5;
		for (const heightPx of [6, 7, 11, 13, 16, 17, 19, 20, 23, 29, 32, 37, 40, 64]) {
			setSixelSupport(true);
			setCellDimensions({ widthPx: Math.max(3, Math.round(heightPx * 0.5)), heightPx });
			const lines = new StartupScreen(makeData({ recentSessions: [] })).render(80);
			const petLine = lines.find((l) => l.includes("\x1bP"));
			expect(petLine, `cell ${heightPx}px: expected a sixel hero`).toBeDefined();

			const declared = Number(petLine!.match(/"1;1;\d+;(\d+)/)![1]);
			const bandRounded = Math.ceil(declared / BAND) * BAND;
			expect(bandRounded, `cell ${heightPx}px: band-rounded ${bandRounded}px`).toBeLessThanOrEqual(
				DRAW_ROWS * heightPx,
			);
			resetCellDimensions();
		}
	});

	test("cell and sixel pet units render at the SAME height (no mode-switch layout jump)", () => {
		// The cell-size answer lands asynchronously: the welcome painted in cells at
		// PET_CELL_ROWS, then flipped to a sixel block of PET_SIXEL_ROWS — the whole
		// reveal below re-anchored mid-animation. The sixel unit now pads out to the
		// cell unit's height, bottom-anchoring the smaller sprite.
		setSixelSupport(true);
		const cells = new StartupScreen(makeData({ recentSessions: [] })).render(80);
		setCellDimensions({ widthPx: 10, heightPx: 20 });
		const sixel = new StartupScreen(makeData({ recentSessions: [] })).render(80);
		// Compare the pet unit alone: everything above the identity line.
		const unitHeight = (lines: string[]) => lines.findIndex((l) => stripVTControlCharacters(l).includes("pit v"));
		expect(unitHeight(cells)).toBeGreaterThan(0);
		expect(unitHeight(sixel)).toBe(unitHeight(cells));
		// And the sprite is still there, anchored at the unit's bottom row.
		expect(sixel.some((l) => l.includes("\x1bP"))).toBe(true);
	});

	test("sixel stands down until the terminal reports its cell size", () => {
		// The sprite's height is authored in rows and emitted in pixels; without a
		// measured cell that conversion is a guess, and a guess that runs tall draws
		// over rows the block does not own.
		setSixelSupport(true);
		const lines = new StartupScreen(makeData({ recentSessions: [] })).render(80);
		expect(lines.some((l) => l.includes("\x1bP"))).toBe(false);
		expect(lines.join("")).toMatch(/[▀▄]/); // cell fallback drew instead
	});

	test("blink dips the pet mid-window then reopens", () => {
		const screen = new StartupScreen(makeData({ reducedMotion: false, recentSessions: [] }));
		// units = pet + identity = 2 → revealDone at 1*110=110ms, blink at 810ms.
		screen.tick(0);
		screen.tick(850); // inside the blink window [810, 940)
		const blinking = screen.render(80).join("");
		screen.tick(2000); // after the blink
		const open = screen.render(80).join("");
		expect(blinking).not.toEqual(open);
		expect(screen.isSettled()).toBe(true);
	});

	test("after the blink the pet glances down toward the editor, then settles static", () => {
		setSixelSupport(false); // keep the comparison on the deterministic cell path
		const screen = new StartupScreen(makeData({ reducedMotion: false, recentSessions: [] }));
		screen.tick(0);
		// 2 units → revealDone 110ms → blink [810, 940) → glance [1100, 1620).
		screen.tick(1050); // blink over, glance not yet begun
		const resting = screen.render(80).join("");
		screen.tick(1400); // mid-glance (p ≈ 0.58 → eyes near the dip's peak)
		const glancing = screen.render(80).join("");
		screen.tick(1800); // glance finished — the screen is now final
		const settled = screen.render(80).join("");
		expect(glancing).not.toEqual(resting); // a visible, one-shot beat
		expect(settled).toEqual(resting); // deterministic: exactly back to the resting frame
		expect(screen.isSettled()).toBe(true); // …so the host unsubscribes right after
	});
});
