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

describe("deriveThinkingTail — windowed sanitization", () => {
	/** Full-scan oracle: a window at least as large as the buffer sanitizes everything. */
	const fullTail = (raw: string, maxWidth: number) => deriveThinkingTail(raw, maxWidth, raw.length + 1);

	const proseLines = (count: number, prefix = "line") =>
		Array.from({ length: count }, (_, i) => `${prefix} ${i} with some ordinary reasoning words`).join("\n");

	test("small window matches the full scan on plain prose", () => {
		const raw = proseLines(200);
		expect(deriveThinkingTail(raw, 70, 512)).toBe(fullTail(raw, 70));
	});

	test("small window matches the full scan with closed fences near the tail", () => {
		const raw = `${proseLines(100)}\n\`\`\`ts\nconst hidden = 1;\n\`\`\`\nvisible after the fence with plenty of words to fill`;
		const windowed = deriveThinkingTail(raw, 70, 512);
		expect(windowed).toBe(fullTail(raw, 70));
		expect(windowed).not.toContain("hidden");
	});

	test("window starting inside a closed fence skips past its closer", () => {
		// The fence body is larger than the window, so the window opens mid-code.
		const bigFence = `\`\`\`js\n${"const noise = 0;\n".repeat(100)}\`\`\``;
		const raw = `${proseLines(3, "before")}\n${bigFence}\nafter the code we keep reasoning about the actual problem`;
		const windowed = deriveThinkingTail(raw, 70, 256);
		expect(windowed).toBe(fullTail(raw, 70));
		expect(windowed).not.toContain("noise");
	});

	test("open trailing fence larger than the window still shows the prose before it", () => {
		const raw = `${proseLines(5, "prose")}\n\`\`\`ts\n${"streamed code line;\n".repeat(500)}`;
		const windowed = deriveThinkingTail(raw, 70, 256);
		expect(windowed).toBe(fullTail(raw, 70));
		expect(windowed).not.toContain("streamed");
		expect(windowed.length).toBeGreaterThan(0);
	});

	test("append-only streaming (the 300ms tick) stays equivalent to the full scan at every step", () => {
		let raw = "";
		const chunks = [
			"first burst of reasoning\n",
			"## a heading marker\n- a bullet\n",
			"```py\nx = 1\n",
			"y = 2\n```\n",
			"back to prose after the fence closed and more words to make it long enough\n",
			proseLines(50, "tail"),
		];
		for (const chunk of chunks) {
			raw += chunk;
			expect(deriveThinkingTail(raw, 70, 128)).toBe(fullTail(raw, 70));
		}
	});

	test("non-append input (buffer reset) still yields correct results", () => {
		const a = `${proseLines(80, "alpha")}\n\`\`\`\nfenced\n\`\`\`\nomega words at the end for the visible tail`;
		expect(deriveThinkingTail(a, 70, 256)).toBe(fullTail(a, 70));
		// Completely different buffer afterwards: the incremental fence cache must
		// fall back to a full rescan, not reuse stale indices.
		const b = `${proseLines(90, "beta")}\ndistinct closing words for the second buffer`;
		expect(deriveThinkingTail(b, 70, 256)).toBe(fullTail(b, 70));
		// And back to (a) again.
		expect(deriveThinkingTail(a, 70, 256)).toBe(fullTail(a, 70));
	});

	test("large buffer (way past the default window) produces the same tail as the full scan", () => {
		const raw = `${proseLines(5000)}\nfinal thought about the fix`;
		expect(raw.length).toBeGreaterThan(100_000);
		expect(deriveThinkingTail(raw, 70)).toBe(fullTail(raw, 70));
		expect(deriveThinkingTail(raw, 70)).toContain("final thought about the fix");
	});
});
