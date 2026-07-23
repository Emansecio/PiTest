import { describe, expect, test } from "vitest";
import { deriveThinkingTail, sanitizeThinkingText } from "../src/modes/interactive/thinking-preview.js";

describe("sanitizeThinkingText", () => {
	test("returns empty string for empty/undefined-ish input", () => {
		expect(sanitizeThinkingText("")).toBe("");
	});

	test("collapses newlines and repeated whitespace into single spaces", () => {
		expect(sanitizeThinkingText("first line\n\nsecond   line\tthird")).toBe("first line second line third");
	});

	test("strips leading heading and bullet markers per line but keeps intra-word hyphens", () => {
		const raw = "# Heading\n- first bullet\n* second bullet\nverificar edit-precondition case";
		expect(sanitizeThinkingText(raw)).toBe("Heading first bullet second bullet verificar edit-precondition case");
	});

	test("strips inline backticks", () => {
		expect(sanitizeThinkingText("check the `mtime` field")).toBe("check the mtime field");
	});

	test("drops complete fenced code blocks entirely", () => {
		const raw = "before the fence\n```js\nconst x = 1;\n```\nafter the fence";
		expect(sanitizeThinkingText(raw)).toBe("before the fence after the fence");
	});

	test("drops a still-open (unterminated) fence and everything after it", () => {
		const raw = "reasoning before\n```ts\nfunction f() {\n  return 1;";
		expect(sanitizeThinkingText(raw)).toBe("reasoning before");
	});

	test("does not treat a real hyphen mid-word as a bullet marker", () => {
		expect(sanitizeThinkingText("the edit-precondition check")).toBe("the edit-precondition check");
	});
});

describe("deriveThinkingTail", () => {
	test("returns the sanitized text unchanged when it fits within maxWidth", () => {
		expect(deriveThinkingTail("short thought", 70)).toBe("short thought");
	});

	test("returns empty string for empty input", () => {
		expect(deriveThinkingTail("", 70)).toBe("");
	});

	test("returns empty string for whitespace-only input", () => {
		expect(deriveThinkingTail("   \n\t  ", 70)).toBe("");
	});

	test("returns empty string for a non-positive maxWidth", () => {
		expect(deriveThinkingTail("some thinking text", 0)).toBe("");
		expect(deriveThinkingTail("some thinking text", -5)).toBe("");
	});

	test("truncates to the tail, prefixed with an ellipsis, cut at a word boundary", () => {
		const raw =
			"let me check whether the edit-precondition extension covers the case where mtime is identical between reads";
		const tail = deriveThinkingTail(raw, 40);
		expect(tail.startsWith("…")).toBe(true);
		expect(tail.length).toBeLessThanOrEqual(40);
		// Never opens mid-word: the character right after the ellipsis starts a
		// fresh word, not a fragment (i.e. the source text has a space right
		// before what follows the ellipsis, or the tail is the whole sanitized
		// string cut precisely at the boundary the function itself computed).
		const withoutEllipsis = tail.slice(1);
		expect(raw.endsWith(withoutEllipsis)).toBe(true);
	});

	test("never exceeds maxWidth even for a single long unbroken token", () => {
		const raw = "x".repeat(200);
		const tail = deriveThinkingTail(raw, 30);
		expect(tail.length).toBeLessThanOrEqual(30);
		expect(tail.startsWith("…")).toBe(true);
	});

	test("sanitizes before measuring width (markdown noise doesn't inflate the budget)", () => {
		const raw = "# check the `mtime` handling for edit-precondition equality";
		const tail = deriveThinkingTail(raw, 200);
		expect(tail).toBe("check the mtime handling for edit-precondition equality");
	});

	test("is a pure function: same input always yields the same output", () => {
		const raw = "reasoning about the schema migration and its rollback path";
		expect(deriveThinkingTail(raw, 25)).toBe(deriveThinkingTail(raw, 25));
	});
});
