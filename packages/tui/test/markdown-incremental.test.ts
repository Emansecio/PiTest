import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.js";
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
