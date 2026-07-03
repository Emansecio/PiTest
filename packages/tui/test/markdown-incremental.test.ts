import assert from "node:assert";
import { describe, it } from "node:test";
import { hasOpenCodeFence, Markdown } from "../src/components/markdown.js";
import { defaultMarkdownTheme } from "./test-themes.js";

// Equivalence suite for incremental markdown lexation.
//
// The contract: feeding a document to a persistent Markdown via setText() over
// growing prefixes (as streaming does) must produce, at every prefix and every
// width, byte-identical render output to constructing a fresh Markdown on that
// exact prefix. The incremental tail-lex inside render() is an internal
// optimization; this suite is the judge that it never changes a single line.

/**
 * Drive `doc` through growing prefixes and assert instance A (persistent,
 * setText per step — exercises the incremental path) renders identically to
 * instance B (fresh per step — always a full lex) at each width.
 *
 * Cut positions are chosen with several coprime-ish step sizes so prefixes land
 * mid-word, mid-line, right after "\n", and right after "\n\n".
 */
function assertStreamingEquivalence(doc: string, widths: number[]): Markdown {
	const persistent = new Markdown("", 0, 0, defaultMarkdownTheme);

	const cutSet = new Set<number>();
	for (const step of [1, 3, 7, 17]) {
		for (let i = step; i < doc.length; i += step) {
			cutSet.add(i);
		}
	}
	// Always include positions immediately after each newline (line / blank-line
	// boundaries are the structurally interesting cuts).
	for (let i = 0; i < doc.length; i++) {
		if (doc[i] === "\n") {
			cutSet.add(i + 1);
		}
	}
	cutSet.add(doc.length);
	const cuts = [...cutSet].sort((a, b) => a - b);

	for (const cut of cuts) {
		const prefix = doc.slice(0, cut);
		persistent.setText(prefix);
		for (const width of widths) {
			const fresh = new Markdown(prefix, 0, 0, defaultMarkdownTheme);
			const a = persistent.render(width);
			const b = fresh.render(width);
			assert.deepStrictEqual(a, b, `Mismatch at cut=${cut} width=${width} for prefix=${JSON.stringify(prefix)}`);
		}
	}

	return persistent;
}

// Each corpus entry is rendered at width 80 by default; a couple also at 40/120.
const paragraphs = "First paragraph with several words.\n\nSecond paragraph here.\n\nThird and final paragraph.";

const codeFence =
	"Intro line.\n\n```ts\nconst x = 1;\nfunction f(a: number) {\n  return a + 1;\n}\n```\n\nAfter the fence.";

const listLoose = "Heading text\n\n- alpha\n\n- bravo\n\n- charlie";

const listTight = "Heading text\n\n- alpha\n- bravo\n- charlie";

const listInterrupted = "- one\n- two\n\nA paragraph that interrupts the list.\n\n- three\n- four";

const blockquote = "Before.\n\n> line one of the quote\n> line two of the quote\n> line three\n\nAfter.";

const table = "Table follows:\n\n| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |\n\nDone.";

const setext = "Some intro.\n\nThe Title\n=========\n\nBody after setext heading.";

const referenceLink = "See [the docs][x] for details.\n\nMore text in between here.\n\n[x]: https://example.com/docs";

const inlineStyles = "A line with `inline code`, **bold**, _italic_, and ~~struck~~ words together.";

const tabs = "Col1\tCol2\tCol3\n\nText after\ttabs in it.\n\n\t- indented bit";

const htmlBlock = 'Paragraph one.\n\n<div class="box">\n  <span>content</span>\n</div>\n\nParagraph two.';

const headingsMix =
	"# Top heading\n\nSome body.\n\n## Sub heading\n\nMore body with a `code` span.\n\n### Deep\n\nEnd.";

const mixedLong = [
	headingsMix,
	paragraphs,
	codeFence,
	listLoose,
	listInterrupted,
	blockquote,
	table,
	setext,
	inlineStyles,
	htmlBlock,
].join("\n\n");

describe("Markdown incremental lexation equivalence", () => {
	it("paragraphs (width 80/40/120)", () => {
		assertStreamingEquivalence(paragraphs, [80, 40, 120]);
	});

	it("code fence incl. open-fence intermediate states", () => {
		assertStreamingEquivalence(codeFence, [80]);
	});

	it("loose list built by append (- a\\n\\n- b)", () => {
		assertStreamingEquivalence(listLoose, [80]);
	});

	it("tight list", () => {
		assertStreamingEquivalence(listTight, [80]);
	});

	it("list interrupted by a paragraph", () => {
		assertStreamingEquivalence(listInterrupted, [80]);
	});

	it("multi-line blockquote", () => {
		assertStreamingEquivalence(blockquote, [80]);
	});

	it("table", () => {
		assertStreamingEquivalence(table, [80]);
	});

	it("setext heading (title\\n===)", () => {
		assertStreamingEquivalence(setext, [80]);
	});

	it("reference link with definition arriving after use (must fall back)", () => {
		assertStreamingEquivalence(referenceLink, [80]);
	});

	it("inline code / bold / italic / strikethrough", () => {
		assertStreamingEquivalence(inlineStyles, [80]);
	});

	it("text with tabs", () => {
		assertStreamingEquivalence(tabs, [80]);
	});

	it("html block", () => {
		assertStreamingEquivalence(htmlBlock, [80]);
	});

	it("mixed headings", () => {
		assertStreamingEquivalence(headingsMix, [80]);
	});

	it("long mixed document (width 80/40/120)", () => {
		assertStreamingEquivalence(mixedLong, [80, 40, 120]);
	});

	it("exercises the incremental path on simple paragraph append", () => {
		// Build up a multi-paragraph document one chunk at a time. After the first
		// few blocks exist, appending more text to a trailing paragraph (with
		// blank-line separated prior blocks) must hit the incremental tail-lex.
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);
		const base = "Block one.\n\nBlock two.\n\nBlock three is growing";
		const additions = [" with more", " and more", " and even more words here."];
		let text = base;
		md.setText(text);
		md.render(80);
		const before = md._incrementalLexCount();
		for (const add of additions) {
			text += add;
			md.setText(text);
			md.render(80);
		}
		const after = md._incrementalLexCount();
		assert.ok(
			after > before,
			`Expected incremental lex path to fire on paragraph append (before=${before}, after=${after})`,
		);
	});

	it("defers syntax highlight on an open code fence until it closes", () => {
		let highlightCalls = 0;
		const theme = {
			...defaultMarkdownTheme,
			highlightCode: (code: string) => {
				highlightCalls++;
				return code.split("\n").map((line) => `HL:${line}`);
			},
		};
		const md = new Markdown("```ts\nconst x = 1;\n", 0, 0, theme);
		md.render(80);
		assert.equal(highlightCalls, 0);

		md.setText("```ts\nconst x = 1;\n```\n");
		md.render(80);
		assert.equal(highlightCalls, 1);
	});

	it("non-append edits reset cleanly and stay equivalent", () => {
		// A shrink / divergence after streaming must not corrupt the incremental
		// baseline: subsequent renders still match a fresh instance.
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);
		const grown = "alpha\n\nbravo\n\ncharlie delta";
		md.setText(grown);
		assert.deepStrictEqual(md.render(80), new Markdown(grown, 0, 0, defaultMarkdownTheme).render(80));

		const diverged = "completely different\n\ncontent now\n\nhere";
		md.setText(diverged);
		assert.deepStrictEqual(md.render(80), new Markdown(diverged, 0, 0, defaultMarkdownTheme).render(80));

		// Resume appending from the diverged text.
		const resumed = `${diverged} appended`;
		md.setText(resumed);
		assert.deepStrictEqual(md.render(80), new Markdown(resumed, 0, 0, defaultMarkdownTheme).render(80));
	});
});

// Regression suite for the two table-render perf caches (cellMeasureCache,
// cellWrapCache) added alongside per-cell caching in renderTable. The
// contract mirrors the lexation suite above: streaming (growing-text)
// re-renders of a table must be byte-identical to a fresh component built on
// the final text, and — since these caches exist purely for performance —
// unchanged cells must actually hit the cache on the second render.
describe("Markdown table cell cache", () => {
	it("streamed table (2 renders, growing text) matches a fresh instance on the final text", () => {
		const base = "Intro line.\n\n| Name | Role | Notes |\n| --- | --- | --- |\n| Alice | Eng | Works on the";
		const grown = `${base} backend and also owns the deploy pipeline |\n| Bob | PM | Ships things |\n\nDone.`;

		const persistent = new Markdown(base, 0, 0, defaultMarkdownTheme);
		persistent.render(80); // first render: table only has the partial last cell/row
		persistent.setText(grown);
		const streamed = persistent.render(80);

		const fresh = new Markdown(grown, 0, 0, defaultMarkdownTheme).render(80);
		assert.deepStrictEqual(streamed, fresh);
	});

	it("streamed table equivalence across widths (mirrors assertStreamingEquivalence pattern)", () => {
		const doc =
			"Table follows:\n\n| Col A | Col B | Col C |\n| --- | --- | --- |\n| short | a somewhat longer cell value | x |\n| another row | y | z z z |\n\nDone.";
		for (const width of [80, 40, 120]) {
			const persistent = new Markdown("", 0, 0, defaultMarkdownTheme);
			for (let cut = 1; cut <= doc.length; cut += 7) {
				persistent.setText(doc.slice(0, cut));
				const a = persistent.render(width);
				const b = new Markdown(doc.slice(0, cut), 0, 0, defaultMarkdownTheme).render(width);
				assert.deepStrictEqual(a, b, `mismatch at cut=${cut} width=${width}`);
			}
			persistent.setText(doc);
			assert.deepStrictEqual(persistent.render(width), new Markdown(doc, 0, 0, defaultMarkdownTheme).render(width));
		}
	});

	it("re-rendering a table with only the last cell changed hits the measurement cache", () => {
		const before =
			"| Name | Age | City |\n| --- | --- | --- |\n| Alice | 30 | NYC |\n| Bob | 25 | LA |\n| Carl | 40 | SF ";
		const after = `${before}extra`; // only the last cell's text grows

		const md = new Markdown(before, 0, 0, defaultMarkdownTheme);
		md.render(80);
		const hitsBefore = md._cellMeasureCacheHitCount();

		md.setText(after);
		md.render(80);
		const hitsAfter = md._cellMeasureCacheHitCount();

		assert.ok(
			hitsAfter > hitsBefore,
			`expected cellMeasureCache hits on unchanged cells (before=${hitsBefore}, after=${hitsAfter})`,
		);
	});

	it("prunes the measurement cache once it exceeds the entry cap without corrupting output", () => {
		// Build a wide table whose cells are all distinct, forcing the cache well
		// past MAX_CELL_CACHE_ENTRIES (4096) so the clear()-on-overflow path runs.
		const numRows = 600;
		const header = "| A | B | C | D | E | F | G | H |";
		const sep = "| --- | --- | --- | --- | --- | --- | --- | --- |";
		const rows: string[] = [];
		for (let r = 0; r < numRows; r++) {
			const cells = Array.from({ length: 8 }, (_, c) => `r${r}c${c}`);
			rows.push(`| ${cells.join(" | ")} |`);
		}
		const doc = [header, sep, ...rows].join("\n");

		const md = new Markdown(doc, 0, 0, defaultMarkdownTheme);
		const rendered = md.render(80);
		const fresh = new Markdown(doc, 0, 0, defaultMarkdownTheme).render(80);
		assert.deepStrictEqual(rendered, fresh);

		// Re-render (cache already warm/pruned from the render above) still
		// matches — pruning must not leave the cache in a state that produces
		// stale/wrong measurements on a subsequent render of the same table.
		assert.deepStrictEqual(md.render(80), fresh);
	});
});

// Regression suite for the incremental hasOpenCodeFence tracker. The oracle is
// the exported free-function full-scan hasOpenCodeFence(); the persistent
// Markdown instance's internal incremental tracker must always agree with it,
// verified indirectly through code-highlight deferral behavior (the only
// externally observable effect of hasOpenCodeFence) across pathological
// backtick sequences.
describe("Markdown incremental open-code-fence tracking", () => {
	/**
	 * Drive `doc` through every prefix length and assert a persistent instance
	 * (setText per step, exercising the incremental fence tracker) defers code
	 * highlighting identically to a fresh instance at each step — the fresh
	 * instance's hasOpenCodeFence result is always a full scan, so agreement
	 * proves the incremental tracker matches the oracle at every prefix.
	 */
	function assertFenceTrackingEquivalence(doc: string): void {
		const persistent = new Markdown("", 0, 0, defaultMarkdownTheme);
		for (let cut = 1; cut <= doc.length; cut++) {
			const prefix = doc.slice(0, cut);
			persistent.setText(prefix);
			const a = persistent.render(80);
			const b = new Markdown(prefix, 0, 0, defaultMarkdownTheme).render(80);
			assert.deepStrictEqual(a, b, `mismatch at cut=${cut} for prefix=${JSON.stringify(prefix)}`);
		}
	}

	it("agrees with the full-scan oracle across pathological consecutive-backtick appends", () => {
		// Odd run of 5 backticks, then append one more backtick, then a language
		// tag and close — exercises the searchPos 3-byte-skip alignment across
		// awkward boundaries.
		const doc = "text `````\nmore` text\n```ts\ncode here\n```\nafter";
		assertFenceTrackingEquivalence(doc);
	});

	it("agrees with the full-scan oracle for normal fences opening and closing", () => {
		const doc = "Intro\n\n```js\nconst a = 1;\n```\n\nMiddle\n\n```\nplain fence\n```\n\nEnd";
		assertFenceTrackingEquivalence(doc);
	});

	it("agrees with the full-scan oracle when a fence never closes (stays open)", () => {
		const doc = "Before\n\n```python\ndef f():\n    return 1\n";
		assertFenceTrackingEquivalence(doc);
	});

	it("hasOpenCodeFence oracle: odd vs even backtick-triple counts", () => {
		assert.strictEqual(hasOpenCodeFence(""), false);
		assert.strictEqual(hasOpenCodeFence("```"), true);
		assert.strictEqual(hasOpenCodeFence("``````"), false);
		assert.strictEqual(hasOpenCodeFence("`````"), true); // 5 backticks: one ``` match, 2 chars left over
		assert.strictEqual(hasOpenCodeFence("````````"), false); // 8 backticks: two ``` matches (skip-by-3 aligned)
		assert.strictEqual(hasOpenCodeFence("``` ```"), false);
		assert.strictEqual(hasOpenCodeFence("``` ``` ```"), true);
	});

	it("incremental tracker matches the oracle when fed the pathological doc in one shot after growing", () => {
		// Directly exercise the non-monotonic internal state: grow, then jump to
		// an unrelated (non-append) text, then resume appending — the tracker
		// must fall back to a full scan on the non-append edit and stay correct.
		const md = new Markdown("", 0, 0, defaultMarkdownTheme);
		const grown = "`````" + "x";
		md.setText(grown);
		assert.deepStrictEqual(md.render(80), new Markdown(grown, 0, 0, defaultMarkdownTheme).render(80));

		const diverged = "``` totally different ``` content ```";
		md.setText(diverged);
		assert.deepStrictEqual(md.render(80), new Markdown(diverged, 0, 0, defaultMarkdownTheme).render(80));

		const resumed = `${diverged}\`\n\`\`\`ts\ncode\n`;
		md.setText(resumed);
		assert.deepStrictEqual(md.render(80), new Markdown(resumed, 0, 0, defaultMarkdownTheme).render(80));
	});
});
