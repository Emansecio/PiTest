import type { TUI } from "@pit/tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ArminComponent } from "../src/modes/interactive/components/armin.ts";
import { DaxnutsComponent } from "../src/modes/interactive/components/daxnuts.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const originalNoMotion = process.env.PIT_NO_MOTION;

afterEach(() => {
	if (originalNoMotion === undefined) delete process.env.PIT_NO_MOTION;
	else process.env.PIT_NO_MOTION = originalNoMotion;
});

beforeAll(() => initTheme("dark"));

describe("decorative animation accessibility", () => {
	test("easter-egg animations render settled content under reduced motion", () => {
		process.env.PIT_NO_MOTION = "1";
		const addAnimationCallback = vi.fn(() => vi.fn());
		const ui = { addAnimationCallback } as unknown as TUI;

		const armin = new ArminComponent(ui);
		const daxnuts = new DaxnutsComponent(ui);

		expect(addAnimationCallback).not.toHaveBeenCalled();
		expect(armin.render(80).join("\n")).toContain("ARMIN SAYS HI");
		expect(daxnuts.render(80).join("\n")).toContain("Powered by daxnuts");
	});
});
