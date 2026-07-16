import { beforeAll, describe, expect, it } from "vitest";
import {
	_highlightMemoStats,
	getMarkdownTheme,
	highlightCode,
	initTheme,
} from "../src/modes/interactive/theme/theme.ts";

/**
 * The (code, language) highlight memo in theme.ts: width-independent hljs
 * results are cached per concrete Theme instance so resizes (and post-freeze()
 * full re-renders) stop re-lexing every settled code block.
 */
describe("highlight memo", () => {
	beforeAll(() => initTheme("dark"));

	it("hits on a repeated (code, lang) pair and returns byte-identical lines", () => {
		const code = "const memoHitProbe = 42;\nfunction f() { return memoHitProbe; }";
		const before = _highlightMemoStats();
		const first = highlightCode(code, "typescript");
		const afterFirst = _highlightMemoStats();
		const second = highlightCode(code, "typescript");
		const afterSecond = _highlightMemoStats();

		expect(afterFirst.misses).toBe(before.misses + 1);
		expect(afterSecond.hits).toBe(afterFirst.hits + 1);
		expect(afterSecond.misses).toBe(afterFirst.misses);
		expect(second).toEqual(first);
	});

	it("shares the memo between highlightCode and the markdown theme's highlightCode", () => {
		const code = "let sharedEntryProbe = 'x';";
		const first = highlightCode(code, "javascript");
		const before = _highlightMemoStats();
		const viaMarkdownTheme = getMarkdownTheme().highlightCode?.(code, "javascript");
		const after = _highlightMemoStats();

		expect(after.hits).toBe(before.hits + 1);
		expect(after.misses).toBe(before.misses);
		expect(viaMarkdownTheme).toEqual(first);
	});

	it("returns a defensive copy: mutating a result cannot corrupt later hits", () => {
		const code = "const mutationProbe = 1;";
		const first = highlightCode(code, "typescript");
		const pristine = first.slice();
		// write.ts's streaming cache mutates highlightCode results in place —
		// simulate both mutation kinds it performs.
		first[0] = "CORRUPTED";
		first.push("EXTRA LINE");

		const second = highlightCode(code, "typescript");
		expect(second).toEqual(pristine);
		expect(second).not.toBe(first);
	});

	it("isolates languages: same code under a different lang is a separate entry", () => {
		const code = "for x in range(3): print(x)";
		highlightCode(code, "python");
		const before = _highlightMemoStats();
		highlightCode(code, "ruby");
		const afterOtherLang = _highlightMemoStats();
		// Different language -> different key -> miss, not a cross-language hit.
		expect(afterOtherLang.misses).toBe(before.misses + 1);
		expect(afterOtherLang.hits).toBe(before.hits);

		// Both languages now hit independently.
		highlightCode(code, "python");
		highlightCode(code, "ruby");
		const afterRepeats = _highlightMemoStats();
		expect(afterRepeats.hits).toBe(afterOtherLang.hits + 2);
		expect(afterRepeats.misses).toBe(afterOtherLang.misses);
	});

	it("skips the memo for oversized code blocks", () => {
		// > MAX_HIGHLIGHT_MEMO_CODE_CHARS (100k). Neither counter moves: the
		// oversized path bypasses the memo entirely, both times.
		const code = `// ${"x".repeat(100_001)}`;
		const before = _highlightMemoStats();
		const first = highlightCode(code, "typescript");
		const second = highlightCode(code, "typescript");
		const after = _highlightMemoStats();
		expect(after.hits).toBe(before.hits);
		expect(after.misses).toBe(before.misses);
		expect(second).toEqual(first);
	});

	it("evicts by dropping the map once the entry cap is reached", () => {
		const { maxEntries } = _highlightMemoStats();
		const seed = "const evictionSeedProbe = true;";
		highlightCode(seed, "typescript");
		// Confirm the seed is cached before the flood.
		const seeded = _highlightMemoStats();
		highlightCode(seed, "typescript");
		expect(_highlightMemoStats().hits).toBe(seeded.hits + 1);

		// Flood with distinct entries to overflow the cap (cellWrapCache-style
		// eviction clears the whole map rather than tracking LRU).
		for (let i = 0; i < maxEntries; i++) {
			highlightCode(`const evictionFiller${i} = ${i};`, "typescript");
		}

		const before = _highlightMemoStats();
		highlightCode(seed, "typescript");
		const after = _highlightMemoStats();
		expect(after.misses).toBe(before.misses + 1);
		expect(after.hits).toBe(before.hits);
	});

	it("does not serve entries highlighted under a previous theme instance", () => {
		const code = "const themeSwitchProbe = 0;";
		const darkLines = highlightCode(code, "typescript");
		// Theme switch swaps in a brand-new Theme instance; the memo is keyed by
		// the concrete instance, so the same (code, lang) misses and re-highlights
		// with the new palette.
		initTheme("light");
		try {
			const before = _highlightMemoStats();
			const lightLines = highlightCode(code, "typescript");
			const after = _highlightMemoStats();
			expect(after.misses).toBe(before.misses + 1);
			expect(after.hits).toBe(before.hits);
			// Both palettes color the `const` keyword; dark and light resolve
			// syntaxKeyword to different ANSI, so the memoized outputs must differ.
			expect(lightLines).not.toEqual(darkLines);
		} finally {
			initTheme("dark");
		}
	});
});
