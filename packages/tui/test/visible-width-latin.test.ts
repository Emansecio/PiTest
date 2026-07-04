import assert from "node:assert";
import { describe, it } from "node:test";
import { eastAsianWidth } from "get-east-asian-width";
import { extractAnsiCode, getSegmenter, truncateToWidth, visibleWidth } from "../src/utils.js";

// ---------------------------------------------------------------------------
// Legacy oracle
//
// A verbatim copy of the pre-P1 implementation of visibleWidth /
// truncateToWidth / truncateFragmentToWidth (i.e. before the "Latin fast
// path" was added to src/utils.ts). Used to prove the new fast path is
// byte-identical to the previous behavior for every input in the corpus
// below. The width cache is intentionally omitted here: it never changes the
// *result* of visibleWidth, only whether the result is memoized, so it has
// no bearing on an oracle comparison.
// ---------------------------------------------------------------------------

const segmenter = getSegmenter();

function legacyCouldBeEmoji(segment: string): boolean {
	const cp = segment.codePointAt(0)!;
	return (
		(cp >= 0x1f000 && cp <= 0x1fbff) ||
		(cp >= 0x2300 && cp <= 0x23ff) ||
		(cp >= 0x2600 && cp <= 0x27bf) ||
		(cp >= 0x2b50 && cp <= 0x2b55) ||
		segment.includes("️") ||
		segment.length > 2
	);
}

const legacyZeroWidthRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v;
const legacyLeadingNonPrintingRegex = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
const legacyRgiEmojiRegex = /^\p{RGI_Emoji}$/v;

function legacyGraphemeWidth(segment: string): number {
	if (legacyZeroWidthRegex.test(segment)) {
		return 0;
	}
	if (legacyCouldBeEmoji(segment) && legacyRgiEmojiRegex.test(segment)) {
		return 2;
	}
	const base = segment.replace(legacyLeadingNonPrintingRegex, "");
	const cp = base.codePointAt(0);
	if (cp === undefined) {
		return 0;
	}
	if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
		return 2;
	}
	let width = eastAsianWidth(cp);
	if (segment.length > 1) {
		for (const char of segment.slice(1)) {
			const c = char.codePointAt(0)!;
			if (c >= 0xff00 && c <= 0xffef) {
				width += eastAsianWidth(c);
			} else if (c === 0x0e33 || c === 0x0eb3) {
				width += 1;
			}
		}
	}
	return width;
}

function legacyIsPrintableAscii(str: string): boolean {
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) {
			return false;
		}
	}
	return true;
}

/** Pre-P1 visibleWidth: ASCII fast path, otherwise strip tabs/ANSI and sum grapheme widths. */
function legacyVisibleWidth(str: string): number {
	if (str.length === 0) {
		return 0;
	}
	if (legacyIsPrintableAscii(str)) {
		return str.length;
	}

	let clean = str;
	if (str.includes("\t")) {
		clean = clean.replace(/\t/g, "   ");
	}
	if (clean.includes("\x1b")) {
		const parts: string[] = [];
		let i = 0;
		while (i < clean.length) {
			const nextEsc = clean.indexOf("\x1b", i);
			if (nextEsc === -1) {
				parts.push(clean.slice(i));
				break;
			}
			if (nextEsc > i) {
				parts.push(clean.slice(i, nextEsc));
			}
			const ansi = extractAnsiCode(clean, nextEsc);
			i = ansi ? nextEsc + ansi.length : nextEsc + 1;
		}
		clean = parts.join("");
	}

	let width = 0;
	for (const { segment } of segmenter.segment(clean)) {
		width += legacyGraphemeWidth(segment);
	}
	return width;
}

function legacyFinalizeTruncatedResult(
	prefix: string,
	prefixWidth: number,
	ellipsis: string,
	ellipsisWidth: number,
	maxWidth: number,
	pad: boolean,
): string {
	const reset = "\x1b[0m";
	const visible = prefixWidth + ellipsisWidth;
	let result: string;
	if (ellipsis.length > 0) {
		result = `${prefix}${reset}${ellipsis}${reset}`;
	} else {
		result = `${prefix}${reset}`;
	}
	return pad ? result + " ".repeat(Math.max(0, maxWidth - visible)) : result;
}

function legacyTruncateFragmentToWidth(text: string, maxWidth: number): { text: string; width: number } {
	if (maxWidth <= 0 || text.length === 0) {
		return { text: "", width: 0 };
	}
	if (legacyIsPrintableAscii(text)) {
		const clipped = text.slice(0, maxWidth);
		return { text: clipped, width: clipped.length };
	}

	const hasAnsi = text.includes("\x1b");
	const hasTabs = text.includes("\t");
	if (!hasAnsi && !hasTabs) {
		let result = "";
		let width = 0;
		for (const { segment } of segmenter.segment(text)) {
			const w = legacyGraphemeWidth(segment);
			if (width + w > maxWidth) {
				break;
			}
			result += segment;
			width += w;
		}
		return { text: result, width };
	}

	let result = "";
	let width = 0;
	let i = 0;
	let pendingAnsi = "";

	while (i < text.length) {
		const ansi = extractAnsiCode(text, i);
		if (ansi) {
			pendingAnsi += ansi.code;
			i += ansi.length;
			continue;
		}

		if (text[i] === "\t") {
			if (width + 3 > maxWidth) {
				break;
			}
			if (pendingAnsi) {
				result += pendingAnsi;
				pendingAnsi = "";
			}
			result += "\t";
			width += 3;
			i++;
			continue;
		}

		let end = i;
		while (end < text.length && text[end] !== "\t") {
			const nextAnsi = extractAnsiCode(text, end);
			if (nextAnsi) {
				break;
			}
			end++;
		}

		for (const { segment } of segmenter.segment(text.slice(i, end))) {
			const w = legacyGraphemeWidth(segment);
			if (width + w > maxWidth) {
				return { text: result, width };
			}
			if (pendingAnsi) {
				result += pendingAnsi;
				pendingAnsi = "";
			}
			result += segment;
			width += w;
		}
		i = end;
	}

	return { text: result, width };
}

function legacyTruncateToWidth(text: string, maxWidth: number, ellipsis: string = "…", pad: boolean = false): string {
	if (maxWidth <= 0) {
		return "";
	}
	if (text.length === 0) {
		return pad ? " ".repeat(maxWidth) : "";
	}

	const ellipsisWidth = legacyVisibleWidth(ellipsis);
	if (ellipsisWidth >= maxWidth) {
		const textWidth = legacyVisibleWidth(text);
		if (textWidth <= maxWidth) {
			return pad ? text + " ".repeat(maxWidth - textWidth) : text;
		}
		const clippedEllipsis = legacyTruncateFragmentToWidth(ellipsis, maxWidth);
		if (clippedEllipsis.width === 0) {
			return pad ? " ".repeat(maxWidth) : "";
		}
		return legacyFinalizeTruncatedResult("", 0, clippedEllipsis.text, clippedEllipsis.width, maxWidth, pad);
	}

	if (legacyIsPrintableAscii(text)) {
		if (text.length <= maxWidth) {
			return pad ? text + " ".repeat(maxWidth - text.length) : text;
		}
		const targetWidth = maxWidth - ellipsisWidth;
		return legacyFinalizeTruncatedResult(
			text.slice(0, targetWidth),
			targetWidth,
			ellipsis,
			ellipsisWidth,
			maxWidth,
			pad,
		);
	}

	const targetWidth = maxWidth - ellipsisWidth;
	let result = "";
	let pendingAnsi = "";
	let visibleSoFar = 0;
	let keptWidth = 0;
	let keepContiguousPrefix = true;
	let overflowed = false;
	let exhaustedInput = false;
	const hasAnsi = text.includes("\x1b");
	const hasTabs = text.includes("\t");

	if (!hasAnsi && !hasTabs) {
		for (const { segment } of segmenter.segment(text)) {
			const width = legacyGraphemeWidth(segment);
			if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
				result += segment;
				keptWidth += width;
			} else {
				keepContiguousPrefix = false;
			}
			visibleSoFar += width;
			if (visibleSoFar > maxWidth) {
				overflowed = true;
				break;
			}
		}
		exhaustedInput = !overflowed;
	} else {
		let i = 0;
		while (i < text.length) {
			const ansi = extractAnsiCode(text, i);
			if (ansi) {
				pendingAnsi += ansi.code;
				i += ansi.length;
				continue;
			}

			if (text[i] === "\t") {
				if (keepContiguousPrefix && keptWidth + 3 <= targetWidth) {
					if (pendingAnsi) {
						result += pendingAnsi;
						pendingAnsi = "";
					}
					result += "\t";
					keptWidth += 3;
				} else {
					keepContiguousPrefix = false;
					pendingAnsi = "";
				}
				visibleSoFar += 3;
				if (visibleSoFar > maxWidth) {
					overflowed = true;
					break;
				}
				i++;
				continue;
			}

			let end = i;
			while (end < text.length && text[end] !== "\t") {
				const nextAnsi = extractAnsiCode(text, end);
				if (nextAnsi) {
					break;
				}
				end++;
			}

			for (const { segment } of segmenter.segment(text.slice(i, end))) {
				const width = legacyGraphemeWidth(segment);
				if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
					if (pendingAnsi) {
						result += pendingAnsi;
						pendingAnsi = "";
					}
					result += segment;
					keptWidth += width;
				} else {
					keepContiguousPrefix = false;
					pendingAnsi = "";
				}

				visibleSoFar += width;
				if (visibleSoFar > maxWidth) {
					overflowed = true;
					break;
				}
			}
			if (overflowed) {
				break;
			}
			i = end;
		}
		exhaustedInput = i >= text.length;
	}

	if (!overflowed && exhaustedInput) {
		return pad ? text + " ".repeat(Math.max(0, maxWidth - visibleSoFar)) : text;
	}

	return legacyFinalizeTruncatedResult(result, keptWidth, ellipsis, ellipsisWidth, maxWidth, pad);
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

function rangeString(start: number, end: number): string {
	let s = "";
	for (let cp = start; cp <= end; cp++) s += String.fromCharCode(cp);
	return s;
}

const PT_BR_PHRASES = [
	"ação",
	"coração",
	"você",
	"não",
	"informação",
	"ímã",
	"órgão",
	"área",
	"pêssego",
	"única",
	"àquele",
	"através",
	"pequeno",
	"grande é bom",
	"O rápido cão marrom pula sobre a preguiçosa raposa às vezes, não é mesmo? São questões importantíssimas.",
	"café com açúcar e limão, por favor — é ótimo!",
	"Ação, informação, órgão, ímã, pêssego, única, àquele, através: tudo junto numa frase só, pra ver se dá tudo certo mesmo com muitos acentos diferentes espalhados por aí.",
];

const NBSP = " ";
const SOFT_HYPHEN = "­";
const COMBINING_ACUTE = "e" + "́"; // "e" + combining acute accent (U+0301) — must stay on the slow path
const MULTIPLICATION_SIGN = "×"; // ×
const DIVISION_SIGN = "÷"; // ÷
const IPA_SAMPLE = rangeString(0x0250, 0x02af); // IPA Extensions + Spacing Modifier Letters
const CJK = "日本語";
const ZWJ_FAMILY = "👨‍👩‍👧‍👦";
const EMOJI = "🙂";
const ASCII_ONLY = "The quick brown fox jumps over the lazy dog 1234567890!";

const CORPUS: string[] = [
	"",
	ASCII_ONLY,
	...PT_BR_PHRASES,
	NBSP,
	`${NBSP}abc${NBSP}`,
	SOFT_HYPHEN,
	`abc${SOFT_HYPHEN}def`,
	COMBINING_ACUTE,
	`caf${COMBINING_ACUTE} com leite`,
	MULTIPLICATION_SIGN,
	DIVISION_SIGN,
	`3${MULTIPLICATION_SIGN}4=12, 10${DIVISION_SIGN}2=5`,
	IPA_SAMPLE,
	`ação com ansi \x1b[31mação\x1b[0m fim`,
	`\tação com tab`,
	`ação\t${EMOJI}\tfim`,
	EMOJI,
	`ação ${EMOJI} fim`,
	CJK,
	`ação ${CJK} fim`,
	ZWJ_FAMILY,
	`familia ${ZWJ_FAMILY} aqui`,
	"ação".repeat(2000), // > 4096 chars, Latin-fast-path eligible
	"a".repeat(5000), // > 4096 chars, ASCII-only
	CJK.repeat(2000), // > 4096 chars, slow path throughout
];

describe("visibleWidth: Latin fast path matches legacy oracle", () => {
	it("matches for every codepoint in [0x00, 0x400) as a singleton string", () => {
		// Exhaustively sweeps the boundary the fast path relies on: ASCII,
		// C1 controls, Latin-1 Supplement, Latin Extended-A/B, IPA, Spacing
		// Modifiers, and the start of Combining Diacritical Marks.
		for (let cp = 0x00; cp < 0x400; cp++) {
			const s = String.fromCharCode(cp);
			assert.strictEqual(
				visibleWidth(s),
				legacyVisibleWidth(s),
				`mismatch for U+${cp.toString(16).toUpperCase().padStart(4, "0")}`,
			);
		}
	});

	it("matches for the PT-BR / edge-case corpus", () => {
		for (const s of CORPUS) {
			assert.strictEqual(visibleWidth(s), legacyVisibleWidth(s), `mismatch for: ${JSON.stringify(s).slice(0, 60)}`);
		}
	});

	it("spot-checks the cases called out in the audit", () => {
		assert.strictEqual(visibleWidth("ação"), 4);
		assert.strictEqual(visibleWidth(MULTIPLICATION_SIGN), 1);
		assert.strictEqual(visibleWidth(DIVISION_SIGN), 1);
		assert.strictEqual(visibleWidth(NBSP), 1);
		assert.strictEqual(visibleWidth(SOFT_HYPHEN), 0); // Default_Ignorable: must NOT take the fast path
		assert.strictEqual(visibleWidth(COMBINING_ACUTE), 1); // combines into one width-1 cluster on the slow path
		assert.strictEqual(visibleWidth(CJK), 6);
		assert.strictEqual(visibleWidth(EMOJI), 2);
	});
});

describe("truncateToWidth: Latin fast path matches legacy oracle", () => {
	const widths = [0, 1, 2, 3, 5, 8, 10, 20];
	const ellipses = ["…", "", "...", "🙂"];

	it("matches for the PT-BR / edge-case corpus across widths, pad, and ellipsis variants", () => {
		for (const s of CORPUS) {
			for (const w of widths) {
				for (const pad of [false, true]) {
					for (const ellipsis of ellipses) {
						assert.strictEqual(
							truncateToWidth(s, w, ellipsis, pad),
							legacyTruncateToWidth(s, w, ellipsis, pad),
							`mismatch for text=${JSON.stringify(s).slice(0, 40)} width=${w} pad=${pad} ellipsis=${JSON.stringify(ellipsis)}`,
						);
					}
				}
			}
		}
	});
});

describe("Latin fast path: no observable cache pollution", () => {
	// The width cache and grapheme segmenter are private module state (not
	// exported), so there is no direct way to assert the fast path skips
	// them. As a proxy, confirm repeated calls on the same Latin-eligible
	// string (which never touches the cache under the new fast path) return
	// a stable, correct value across many repetitions, interleaved with a
	// string that *does* go through the cache/segmenter path — i.e. the fast
	// path cannot corrupt, or be corrupted by, cache state.
	it("returns a consistent width for repeated Latin-eligible strings interleaved with cached strings", () => {
		const latin = "informação, órgão, ação";
		const cached = "日本語のテキスト"; // goes through the segmenter + cache path
		const expectedLatin = legacyVisibleWidth(latin);
		const expectedCached = legacyVisibleWidth(cached);

		for (let i = 0; i < 5000; i++) {
			assert.strictEqual(visibleWidth(latin), expectedLatin);
			assert.strictEqual(visibleWidth(cached), expectedCached);
		}
	});
});
