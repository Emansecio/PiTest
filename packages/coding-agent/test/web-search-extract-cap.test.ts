/**
 * M22 — web_search extract capping.
 *
 * `capExtractBody` upgrades the old raw char-cut of per-result extracts:
 *  1. JSON payloads (raw API endpoint behind the URL) are structurally crushed
 *     via the shared json-crush machinery instead of blind-cut.
 *  2. Runs of identical lines (HTML nav/footer noise) collapse losslessly, and
 *     when that alone fits the cap nothing else is cut.
 *  3. Otherwise the cut lands on the last sentence/line boundary before the
 *     cap, floored at 60% of it; below the floor the raw char cut applies.
 * Text at or under the cap is returned byte-identical (upgrade-only contract).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capExtractBody } from "../src/core/tools/web-search.ts";

const CAP = 200;

describe("capExtractBody", () => {
	it("returns text at or under the cap byte-identical", () => {
		const short = "A tidy extract. With two sentences.";
		expect(capExtractBody(short, CAP)).toBe(short);
		const exact = "x".repeat(CAP);
		expect(capExtractBody(exact, CAP)).toBe(exact);
	});

	it("cuts prose on the last sentence boundary before the cap", () => {
		const sentence = "This extract talks about token economy at length. ";
		const body = capExtractBody(sentence.repeat(20), CAP);
		expect(body.length).toBeLessThanOrEqual(CAP);
		expect(body.endsWith("...")).toBe(true);
		const kept = body.slice(0, -3);
		// The cut landed after a sentence-final period, not mid-sentence…
		expect(kept.endsWith(".")).toBe(true);
		// …and is a clean prefix of whole sentences.
		expect(kept.trimEnd()).toBe(sentence.repeat(20).slice(0, kept.length).trimEnd());
		// The boundary respected the 60% floor: most of the budget is used.
		expect(kept.length).toBeGreaterThanOrEqual(Math.floor(CAP * 0.6));
	});

	it("treats a newline as a boundary (markdown extracts are line-structured)", () => {
		const line = "- markdown bullet item with some words";
		const text = Array.from({ length: 20 }, (_, i) => `${line} ${i}`).join("\n");
		const body = capExtractBody(text, CAP);
		expect(body.length).toBeLessThanOrEqual(CAP);
		expect(body.endsWith("...")).toBe(true);
		// The kept part ends on a COMPLETE line, not a mid-line stump.
		const kept = body.slice(0, -3);
		expect(text.startsWith(kept)).toBe(true);
		expect(text.charAt(kept.length)).toBe("\n");
	});

	it("falls back to the raw char cut when the last boundary sits under the 60% floor", () => {
		// Only boundary is at index 3 ("No." + space), far below floor(200 * 0.6).
		const text = `No. ${"x".repeat(400)}`;
		const body = capExtractBody(text, CAP);
		expect(body.length).toBe(CAP); // (CAP - 3) chars + "..."
		expect(body.slice(0, -3)).toBe(text.slice(0, CAP - 3));
	});

	it("does not treat decimals or dotted identifiers as boundaries", () => {
		// Every "." is inside a token ("3.14159", "pkg.module.name") — no boundary,
		// so the raw cut applies instead of a bogus mid-token "sentence" cut.
		const token = "pi=3.14159 pkg.module.name ";
		const text = token.repeat(30);
		const body = capExtractBody(text, CAP);
		expect(body.length).toBe(CAP);
		expect(body.slice(0, -3)).toBe(text.slice(0, CAP - 3));
	});

	it("collapses runs of identical lines and skips cutting when that fits", () => {
		const text = Array(100).fill("cookie banner nav item").join("\n");
		expect(text.length).toBeGreaterThan(CAP);
		const body = capExtractBody(text, CAP);
		expect(body.length).toBeLessThanOrEqual(CAP);
		// Lossless collapse marker instead of a blind cut.
		expect(body).toContain("cookie banner nav item … (×100)");
		expect(body.endsWith("...")).toBe(false);
	});

	describe("JSON payloads", () => {
		let savedFlag: string | undefined;
		beforeEach(() => {
			savedFlag = process.env.PIT_NO_JSON_CRUSH;
			delete process.env.PIT_NO_JSON_CRUSH;
		});
		afterEach(() => {
			if (savedFlag === undefined) delete process.env.PIT_NO_JSON_CRUSH;
			else process.env.PIT_NO_JSON_CRUSH = savedFlag;
		});

		it("structurally crushes an oversized JSON extract instead of char-cutting it", () => {
			const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `user-${i}`, role: "admin" }));
			const json = JSON.stringify(rows);
			const max = 2048;
			expect(json.length).toBeGreaterThan(max);

			const body = capExtractBody(json, max);
			expect(body).toContain("[crushed JSON");
			expect(body).toContain("Fetch the URL directly for the full payload.");
			// Schema + samples survive; the bulk of the array does not.
			expect(body).toContain("user-0");
			expect(body.length).toBeLessThan(max + 200); // crush budget + standard footer
		});

		it("falls through to the text path when crushing is disabled", () => {
			process.env.PIT_NO_JSON_CRUSH = "1";
			const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `user-${i}` }));
			const body = capExtractBody(JSON.stringify(rows), CAP);
			expect(body).not.toContain("[crushed JSON");
			expect(body.length).toBeLessThanOrEqual(CAP);
		});
	});
});
