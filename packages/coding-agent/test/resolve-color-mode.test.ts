import { afterEach, describe, expect, it } from "vitest";
import { resolveColorMode, setTheme, theme } from "../src/modes/interactive/theme/theme.js";

describe("resolveColorMode", () => {
	const capsTrue = { trueColor: true };
	const caps256 = { trueColor: false };

	it("FORCE_COLOR=0 → none", () => {
		expect(resolveColorMode({ FORCE_COLOR: "0" }, capsTrue)).toBe("none");
		expect(resolveColorMode({ FORCE_COLOR: "false" }, capsTrue)).toBe("none");
	});

	it("FORCE_COLOR=1|2 → 256 (no 16-color path)", () => {
		expect(resolveColorMode({ FORCE_COLOR: "1" }, capsTrue)).toBe("256color");
		expect(resolveColorMode({ FORCE_COLOR: "2" }, capsTrue)).toBe("256color");
	});

	it("FORCE_COLOR=3 → truecolor when capable, else 256", () => {
		expect(resolveColorMode({ FORCE_COLOR: "3" }, capsTrue)).toBe("truecolor");
		expect(resolveColorMode({ FORCE_COLOR: "3" }, caps256)).toBe("256color");
		expect(resolveColorMode({ FORCE_COLOR: "true" }, capsTrue)).toBe("truecolor");
	});

	it("NO_COLOR present → none (when FORCE_COLOR unset)", () => {
		expect(resolveColorMode({ NO_COLOR: "" }, capsTrue)).toBe("none");
		expect(resolveColorMode({ NO_COLOR: "1" }, capsTrue)).toBe("none");
	});

	it("FORCE_COLOR wins over NO_COLOR", () => {
		expect(resolveColorMode({ FORCE_COLOR: "1", NO_COLOR: "1" }, capsTrue)).toBe("256color");
		expect(resolveColorMode({ FORCE_COLOR: "0", NO_COLOR: "" }, capsTrue)).toBe("none");
	});

	it("auto: trueColor cap → truecolor, else 256", () => {
		expect(resolveColorMode({}, capsTrue)).toBe("truecolor");
		expect(resolveColorMode({}, caps256)).toBe("256color");
	});
});

describe("Theme fg/bg under ColorMode none", () => {
	afterEach(() => {
		delete process.env.NO_COLOR;
		delete process.env.FORCE_COLOR;
		// Restore a colored dark theme so later files in the same worker aren't mono.
		setTheme("dark", false);
	});

	it("fg/bg/ellipsis emit no ANSI when mode is none", () => {
		process.env.NO_COLOR = "1";
		delete process.env.FORCE_COLOR;
		const result = setTheme("dark", false);
		expect(result.success).toBe(true);
		expect(theme.getColorMode()).toBe("none");
		const fg = theme.fg("accent", "hello");
		const bg = theme.bg("selectedBg", "hello");
		expect(fg).toBe("hello");
		expect(bg).toBe("hello");
		expect(fg).not.toContain("\x1b");
		expect(theme.ellipsis()).toBe("…");
		expect(theme.bold("x")).toBe("x");
	});
});
