import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeJoinedTextMemo, sanitizeSurrogatesMemo } from "../src/utils/sanitize-memo.ts";
import * as sanitizeUnicode from "../src/utils/sanitize-unicode.ts";

// An unpaired high surrogate: sanitizeSurrogates must strip it.
const UNPAIRED = String.fromCharCode(0xd83d);

afterEach(() => {
	vi.restoreAllMocks();
});

describe("sanitizeSurrogatesMemo", () => {
	it("sanitizes once for a stable object + string, serving cached output on repeats", () => {
		const spy = vi.spyOn(sanitizeUnicode, "sanitizeSurrogates");
		const block = { type: "text", text: `keep ${UNPAIRED} me` };
		const a = sanitizeSurrogatesMemo(block, block.text);
		const b = sanitizeSurrogatesMemo(block, block.text);
		const c = sanitizeSurrogatesMemo(block, block.text);
		expect(a).toBe("keep  me");
		expect(b).toBe(a);
		expect(c).toBe(a);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("re-sanitizes when the same key object carries replaced/mutated content", () => {
		const spy = vi.spyOn(sanitizeUnicode, "sanitizeSurrogates");
		const block = { text: "first" };
		expect(sanitizeSurrogatesMemo(block, block.text)).toBe("first");
		// Mutate in place: new string ref under the same key object.
		block.text = "second";
		expect(sanitizeSurrogatesMemo(block, block.text)).toBe("second");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("keeps separate cache slots per distinct key object", () => {
		const spy = vi.spyOn(sanitizeUnicode, "sanitizeSurrogates");
		const b1 = { text: "one" };
		const b2 = { text: "two" };
		sanitizeSurrogatesMemo(b1, b1.text);
		sanitizeSurrogatesMemo(b2, b2.text);
		sanitizeSurrogatesMemo(b1, b1.text); // hit
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("matches raw sanitizeSurrogates output", () => {
		const block = {};
		const input = `a${UNPAIRED}b`;
		expect(sanitizeSurrogatesMemo(block, input)).toBe(sanitizeUnicode.sanitizeSurrogates(input));
	});
});

describe("sanitizeJoinedTextMemo", () => {
	it("joins + sanitizes once while the part string refs are unchanged", () => {
		const spy = vi.spyOn(sanitizeUnicode, "sanitizeSurrogates");
		const content = [{ type: "text" }, { type: "text" }];
		const p1 = "alpha";
		const p2 = `beta ${UNPAIRED}`;
		const a = sanitizeJoinedTextMemo(content, [p1, p2]);
		const b = sanitizeJoinedTextMemo(content, [p1, p2]);
		expect(a).toBe("alpha\nbeta ");
		expect(b).toBe(a);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("re-sanitizes when a part string ref changes under the same content key", () => {
		const spy = vi.spyOn(sanitizeUnicode, "sanitizeSurrogates");
		const content = [{ type: "text" }, { type: "text" }];
		const p1 = "alpha";
		sanitizeJoinedTextMemo(content, [p1, "beta"]);
		sanitizeJoinedTextMemo(content, [p1, "gamma"]); // second part ref differs -> miss
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("re-sanitizes when the number of parts changes", () => {
		const spy = vi.spyOn(sanitizeUnicode, "sanitizeSurrogates");
		const content = [{ type: "text" }];
		const p1 = "alpha";
		sanitizeJoinedTextMemo(content, [p1]);
		sanitizeJoinedTextMemo(content, [p1, "beta"]); // length differs -> miss
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("matches raw sanitizeSurrogates(join) output", () => {
		const content: object[] = [{}];
		const parts = [`x${UNPAIRED}`, "y"];
		expect(sanitizeJoinedTextMemo(content, parts)).toBe(sanitizeUnicode.sanitizeSurrogates(parts.join("\n")));
	});
});
