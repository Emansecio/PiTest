import { stripVTControlCharacters } from "node:util";
import { type PetColors, resetSixelSupport, setSixelSupport, visibleWidth } from "@pit/tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { StartupScreen, type StartupScreenData } from "../src/modes/interactive/components/startup-screen.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	resetSixelSupport();
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
		cwdDisplay: "~/PiTest",
		branch: "main",
		model: "deepseek-v4-pro",
		thinking: "High",
		mode: "auto",
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

	test("renders the workspace context line", () => {
		const text = plain(new StartupScreen(makeData()).render(80));
		expect(text).toContain("~/PiTest");
		expect(text).toContain("main");
		expect(text).toContain("deepseek-v4-pro");
		expect(text).toContain("High");
		expect(text).toContain("auto");
	});

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
		const lines = new StartupScreen(makeData({ recentSessions: [] })).render(80);
		const petLine = lines.find((l) => l.includes("\x1bP"));
		expect(petLine).toBeDefined();
		expect(petLine).toMatch(/\x1bP0;1;0q/); // transparent sixel intro (P2=1)
		expect(petLine).toContain("\x1b7"); // DECSC save cursor
		expect(petLine).toContain("\x1b8"); // DECRC restore cursor
		expect(petLine).toContain("\x1b[2K"); // self-clear reserved rows
		expect(petLine!.endsWith("\x1b8")).toBe(true); // restore is last
	});

	test("blink dips the pet mid-window then reopens", () => {
		const screen = new StartupScreen(makeData({ reducedMotion: false, recentSessions: [] }));
		// units = pet + identity + context = 3 → revealDone at 2*110=220ms, blink at 920ms.
		screen.tick(0);
		screen.tick(950); // inside the blink window
		const blinking = screen.render(80).join("");
		screen.tick(2000); // after the blink
		const open = screen.render(80).join("");
		expect(blinking).not.toEqual(open);
		expect(screen.isSettled()).toBe(true);
	});
});
