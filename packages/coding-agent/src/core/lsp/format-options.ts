/**
 * Per-file `FormattingOptions` for `textDocument/formatting`.
 *
 * Replaces a hardcoded `{ tabSize: 4, insertSpaces: true }` that fed EVERY
 * formatting request regardless of the file or the project: with
 * `lsp.formatOnWrite` on, writing to a tab-indented repo (this one) silently
 * reindented it to 4 spaces, and a 2-space project to 4.
 *
 * Precedence, highest first:
 *   1. `.editorconfig` — the project's declared intent, walked up from the file's
 *      directory and honouring `root = true`, with the usual section matching.
 *   2. Indentation detected in the content about to be written — inference, used
 *      only where nothing was declared.
 *   3. Two spaces. The dominant convention for JSON/YAML/JS/TS and the config
 *      formats most likely to reach a formatter here; the old `4` actively
 *      damaged every 2-space file it touched.
 *
 * The non-indent flags are constant: trailing whitespace, a final newline and
 * collapsing trailing blank lines are what every formatter in this pipeline is
 * expected to do.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "minimatch";

/** The subset of LSP `FormattingOptions` this client sends. */
export interface LspFormattingOptions {
	tabSize: number;
	insertSpaces: boolean;
	trimTrailingWhitespace: boolean;
	insertFinalNewline: boolean;
	trimFinalNewlines: boolean;
}

/** Indentation alone — the only part that varies per file. */
interface IndentStyle {
	tabSize: number;
	insertSpaces: boolean;
}

const FALLBACK_INDENT: IndentStyle = { tabSize: 2, insertSpaces: true };

/** Ceiling on the directory walk, so a pathological path cannot spin. */
const MAX_EDITORCONFIG_DEPTH = 64;

/**
 * Widest indent this module will believe, from either source. When sniffing, a
 * longer run is continuation alignment under an open paren rather than an indent
 * level. When declared, a larger `indent_size`/`tab_width` is nonsense we refuse
 * to forward to a formatter — the fallback is used instead.
 */
const MAX_INDENT_WIDTH = 16;

/** Lines scanned when sniffing indentation — enough to characterise a file, cheap on huge ones. */
const MAX_SNIFF_LINES = 400;

// =============================================================================
// .editorconfig
// =============================================================================

interface EditorConfigSection {
	pattern: string;
	values: Map<string, string>;
}

interface ParsedEditorConfig {
	root: boolean;
	sections: EditorConfigSection[];
}

/** Parsed `.editorconfig` per directory. `null` records "looked, not there". */
const editorConfigCache = new Map<string, ParsedEditorConfig | null>();

/** Drop the parsed-`.editorconfig` cache (config reload / test reset). */
export function clearEditorConfigCache(): void {
	editorConfigCache.clear();
}

/**
 * Minimal INI reader for `.editorconfig`: preamble keys (only `root` matters)
 * followed by `[pattern]` sections. Unparseable lines are skipped rather than
 * failing the file — a malformed `.editorconfig` must never break a write.
 */
function parseEditorConfig(raw: string): ParsedEditorConfig {
	const result: ParsedEditorConfig = { root: false, sections: [] };
	let current: EditorConfigSection | undefined;
	for (const line of raw.split(/\r?\n/)) {
		const text = line.trim();
		if (text.length === 0 || text.startsWith("#") || text.startsWith(";")) continue;
		if (text.startsWith("[") && text.endsWith("]")) {
			current = { pattern: text.slice(1, -1), values: new Map() };
			result.sections.push(current);
			continue;
		}
		const eq = text.indexOf("=");
		if (eq <= 0) continue;
		const key = text.slice(0, eq).trim().toLowerCase();
		const value = text
			.slice(eq + 1)
			.trim()
			.toLowerCase();
		if (current) current.values.set(key, value);
		else if (key === "root") result.root = value === "true";
	}
	return result;
}

function loadEditorConfig(dir: string): ParsedEditorConfig | null {
	const cached = editorConfigCache.get(dir);
	if (cached !== undefined) return cached;
	let parsed: ParsedEditorConfig | null = null;
	try {
		parsed = parseEditorConfig(fs.readFileSync(path.join(dir, ".editorconfig"), "utf-8"));
	} catch {
		// Missing or unreadable: both mean "nothing declared here".
		parsed = null;
	}
	editorConfigCache.set(dir, parsed);
	return parsed;
}

/**
 * Does an `.editorconfig` section pattern cover `relPath` (POSIX-separated,
 * relative to the directory holding that `.editorconfig`)?
 *
 * Per the spec, a pattern containing no `/` matches against the file name in any
 * subdirectory; one that does is anchored at the `.editorconfig`'s directory. A
 * leading `/` is that anchoring made explicit and is stripped.
 */
function sectionMatches(pattern: string, relPath: string): boolean {
	const options = { dot: true, nocase: process.platform === "win32" };
	if (!pattern.includes("/")) {
		return minimatch(path.posix.basename(relPath), pattern, options);
	}
	const anchored = pattern.startsWith("/") ? pattern.slice(1) : pattern;
	return minimatch(relPath, anchored, options);
}

/**
 * Indentation declared for `absolutePath`, or undefined when nothing applies.
 *
 * Walks from the file's directory upward, stopping after a file with
 * `root = true`. Nearer files win over farther ones, and within one file the
 * LAST matching section wins — both are the spec's precedence.
 */
function editorConfigIndent(absolutePath: string): IndentStyle | undefined {
	const values = new Map<string, string>();
	let dir = path.dirname(path.resolve(absolutePath));
	for (let depth = 0; depth < MAX_EDITORCONFIG_DEPTH; depth++) {
		const config = loadEditorConfig(dir);
		if (config) {
			const relPath = path.relative(dir, absolutePath).split(path.sep).join("/");
			for (const section of config.sections) {
				if (!sectionMatches(section.pattern, relPath)) continue;
				for (const [key, value] of section.values) {
					// Nearer directories were merged first; never let a farther one overwrite.
					if (!values.has(key)) values.set(key, value);
				}
			}
			if (config.root) break;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return indentFromEditorConfigValues(values);
}

/**
 * Map `indent_style` / `indent_size` / `tab_width` onto LSP's two fields.
 * Returns undefined when neither key says anything usable, so the caller can
 * fall through to sniffing instead of inventing a width.
 */
function indentFromEditorConfigValues(values: Map<string, string>): IndentStyle | undefined {
	const style = values.get("indent_style");
	const rawSize = values.get("indent_size");
	const rawTabWidth = values.get("tab_width");
	// `indent_size = tab` defers to tab_width, per the spec.
	const sizeSource = rawSize === "tab" ? rawTabWidth : (rawSize ?? rawTabWidth);
	const parsed = sizeSource === undefined ? Number.NaN : Number.parseInt(sizeSource, 10);
	const size = Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_INDENT_WIDTH ? parsed : undefined;

	if (style === "tab") return { insertSpaces: false, tabSize: size ?? FALLBACK_INDENT.tabSize };
	if (style === "space") return { insertSpaces: true, tabSize: size ?? FALLBACK_INDENT.tabSize };
	// A size with no style still pins the width; assume spaces, the common case.
	if (size !== undefined) return { insertSpaces: true, tabSize: size };
	return undefined;
}

// =============================================================================
// Content sniffing
// =============================================================================

/** Greatest common divisor of the observed space-indent widths. */
function gcd(a: number, b: number): number {
	let x = a;
	let y = b;
	while (y !== 0) {
		const next = x % y;
		x = y;
		y = next;
	}
	return x;
}

/**
 * Indentation actually used in `content`, or undefined when it has none to go on.
 *
 * A single tab-indented line settles it — mixing tabs into a space file is not a
 * thing formatters do by accident. Otherwise the width is the GCD of the
 * space-indent widths, which reads 2 from a file of 2/4/6 and 4 from 4/8/12
 * without being fooled by one deeply nested line.
 */
export function detectIndentFromContent(content: string): IndentStyle | undefined {
	let spaceGcd = 0;
	let scanned = 0;
	for (const line of content.split("\n")) {
		if (scanned >= MAX_SNIFF_LINES) break;
		if (line.trim().length === 0) continue;
		scanned++;
		if (line.startsWith("\t")) return { insertSpaces: false, tabSize: FALLBACK_INDENT.tabSize };
		const width = line.length - line.trimStart().length;
		if (width === 0 || width > MAX_INDENT_WIDTH) continue;
		spaceGcd = gcd(spaceGcd, width);
	}
	if (spaceGcd <= 0) return undefined;
	return { insertSpaces: true, tabSize: spaceGcd };
}

// =============================================================================
// Entry point
// =============================================================================

/**
 * `FormattingOptions` for formatting `content` into `absolutePath`. Never throws:
 * every source of information is best-effort and falls through to the next.
 */
export function resolveFormatOptions(absolutePath: string, content: string): LspFormattingOptions {
	let indent: IndentStyle | undefined;
	try {
		indent = editorConfigIndent(absolutePath);
	} catch {
		indent = undefined;
	}
	indent ??= detectIndentFromContent(content);
	const { tabSize, insertSpaces } = indent ?? FALLBACK_INDENT;
	return {
		tabSize,
		insertSpaces,
		trimTrailingWhitespace: true,
		insertFinalNewline: true,
		trimFinalNewlines: true,
	};
}
