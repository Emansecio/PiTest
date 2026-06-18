import { describe, expect, it } from "vitest";
import { sliceSafe, truncateWithEllipsis } from "../src/utils/surrogate.ts";

// An astral char (emoji) is one code POINT made of two UTF-16 code UNITS.
const EMOJI = "😀"; // U+1F600 → surrogate pair (length 2)

describe("sliceSafe", () => {
	it("is byte-identical to String.slice for all-BMP input", () => {
		const s = "hello world";
		expect(sliceSafe(s, 0, 5)).toBe(s.slice(0, 5));
		expect(sliceSafe(s, 6)).toBe(s.slice(6));
		expect(sliceSafe(s, 2, 8)).toBe(s.slice(2, 8));
	});

	it("does not split a surrogate pair at the end boundary (retreats one unit)", () => {
		const s = `ab${EMOJI}cd`; // units: a b D83D DE00 c d  (length 6)
		// A naive slice(0, 3) keeps the lone high surrogate.
		expect(s.slice(0, 3).endsWith("\ud83d")).toBe(true);
		// sliceSafe backs off so no lone surrogate survives.
		const cut = sliceSafe(s, 0, 3);
		expect(cut).toBe("ab");
		expect([...cut].every((ch) => ch.codePointAt(0)! < 0xd800 || ch.codePointAt(0)! > 0xdfff)).toBe(true);
	});

	it("does not begin on a lone low surrogate (advances one unit)", () => {
		const s = `ab${EMOJI}cd`;
		// start=3 lands on the low surrogate; sliceSafe advances to the next char.
		expect(sliceSafe(s, 3)).toBe("cd");
	});

	it("keeps a whole astral char when the boundary doesn't split it", () => {
		const s = `ab${EMOJI}cd`;
		expect(sliceSafe(s, 0, 4)).toBe(`ab${EMOJI}`);
	});
});

describe("truncateWithEllipsis", () => {
	it("returns the string unchanged when it fits", () => {
		expect(truncateWithEllipsis("short", 10)).toBe("short");
	});

	it("matches the s.slice(0, max-1)+… idiom for BMP input", () => {
		const s = "abcdefghij";
		expect(truncateWithEllipsis(s, 5)).toBe(`${s.slice(0, 4)}…`);
	});

	it("never emits a lone surrogate at the cut", () => {
		const s = `abc${EMOJI}defg`; // cutting near the emoji
		const out = truncateWithEllipsis(s, 5); // room = 4, would land mid-pair
		expect(out.endsWith("…")).toBe(true);
		const body = out.slice(0, -1);
		expect([...body].every((ch) => ch.codePointAt(0)! < 0xd800 || ch.codePointAt(0)! > 0xdfff)).toBe(true);
	});
});
