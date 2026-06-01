import { describe, expect, it } from "vitest";
import { extractChromeCommand } from "../src/modes/interactive/interactive-mode.js";

describe("extractChromeCommand", () => {
	it("matches /chrome alone with no remaining text", () => {
		expect(extractChromeCommand("/chrome")).toEqual({ matched: true, rest: "" });
	});

	it("accepts text after /chrome", () => {
		expect(extractChromeCommand("/chrome open google.com and screenshot")).toEqual({
			matched: true,
			rest: "open google.com and screenshot",
		});
	});

	it("accepts text before /chrome", () => {
		expect(extractChromeCommand("open google.com /chrome")).toEqual({ matched: true, rest: "open google.com" });
	});

	it("accepts text before and after /chrome", () => {
		expect(extractChromeCommand("take a screenshot /chrome of github.com")).toEqual({
			matched: true,
			rest: "take a screenshot of github.com",
		});
	});

	it("ignores messages without the token", () => {
		expect(extractChromeCommand("open google.com")).toEqual({ matched: false, rest: "open google.com" });
	});

	it("does not match /chrome as part of a larger word", () => {
		expect(extractChromeCommand("cast to /chromecast device").matched).toBe(false);
	});

	it("is case-insensitive", () => {
		expect(extractChromeCommand("/Chrome go").rest).toBe("go");
	});
});
