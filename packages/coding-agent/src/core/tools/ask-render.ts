/**
 * Transcript rendering for the `ask` tool — the lines that stay in the
 * scrollback after the picker card is dismissed: what was asked, and what the
 * user decided.
 *
 * Three things make this its own module rather than two inline `Text` calls:
 *
 * 1. **Width.** The old call line clipped the question at a hard 80 characters,
 *    so a 200-column terminal still showed `…`. Everything here is laid out
 *    against the real render width.
 * 2. **Hanging indent.** A plain `Text` word-wraps back to column 0, which left
 *    the second line of a long answer dangling under its glyph with no visual
 *    tie to it. Answers wrap under their own glyph instead.
 * 3. **Hierarchy.** The decision outranks the question in the scrollback. While
 *    the picker is open the question is the payload (`text`); once answered it
 *    demotes to context (`muted`) and the answer carries the row.
 *
 * Layout (the `│` gutter comes from the MessageShell, not from here):
 *
 *     │ Question: scope·Which auth flow should the migration assume? (legacy)
 *     │ ❯ Keep both paths alive behind a flag and drop the legacy one after
 *     │   the next release
 *     │   ↳ only if telemetry confirms nobody is on it
 *
 * The question gets exactly one line: while the ask is pending the picker card
 * ({@link file://./../../modes/interactive/ask-picker.ts}) already shows the
 * full text right below, and afterwards the row is context nobody re-reads.
 */

import { type Component, truncateToWidth, visibleWidth } from "@pit/tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { AskToolDetails } from "./ask.ts";

/** Opening label. A word beats the old background chip: it survives themes
 * with no `selectedBg` contrast and costs the same columns as ` ASK  `. */
const LABEL_TEXT = "Question:";
/** Columns the label plus its trailing space consume on the call line. */
const LABEL_COLS = LABEL_TEXT.length + 1;
/** Below this many columns for the question itself, the scope label is dropped. */
const MIN_QUESTION_COLS = 12;
/** An aside narrower than this is not worth the `…` that would replace it. */
const MIN_ASIDE_COLS = 8;
/** The answer echoes the composer's own prompt glyph — it is the user talking,
 * and `✓` already means "step done" everywhere else in the transcript. */
const ICON_ANSWER = "❯";
const ICON_CANCELLED = "✗";
/** Marker for an answer nobody actually gave (auto-selected, no listener bound). */
const ICON_AUTO = "·";
/** Answer glyph + space; continuation lines indent to match. */
const ANSWER_INDENT = "  ";
/** Comment/note marker, nested one step under the answer it annotates. */
const NOTE_MARKER = "↳ ";
const NOTE_INDENT = "    ";
/** Trailing `(…)` on a question: the model's own aside, ranked below the ask
 * itself, so it renders dim and is the first thing the width clip eats. */
const ASIDE_RE = /^(.*?[^\s(])\s*(\([^()]*\))$/;

const RESET = "\x1b[0m";

/** `truncateToWidth` closes its output with a hard `\x1b[0m` so a clipped span
 * cannot leak its style into the rest of the row. That reset is four code units
 * of non-text, so anything that slices or paints the result has to drop it
 * first — see {@link clipPlain} and the hard-break in {@link wrapPlain}. */
function withoutTrailingReset(text: string): string {
	return text.endsWith(RESET) ? text.slice(0, -RESET.length) : text;
}

/**
 * Clip plain (ANSI-free) text, keeping the `…` inside the caller's paint.
 * `truncateToWidth` emits `…` *after* its reset, which on a muted row leaves the
 * ellipsis glowing in the terminal's default color — the one character on the
 * line that is brighter than the text it abbreviates.
 */
function clipPlain(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width === 1) return "…";
	return `${withoutTrailingReset(truncateToWidth(text, width - 1, ""))}…`;
}

/**
 * Word-wrap plain (ANSI-free) text. Over-long single tokens (URLs, paths) are
 * hard-broken rather than overflowing the row and taking `TUI.doRender` down.
 */
function wrapPlain(text: string, width: number): string[] {
	const cols = Math.max(1, width);
	const out: string[] = [];
	let line = "";
	const flush = (): void => {
		if (line !== "") {
			out.push(line);
			line = "";
		}
	};
	for (const word of text.split(/\s+/)) {
		if (!word) continue;
		if (line === "") {
			line = word;
		} else if (visibleWidth(`${line} ${word}`) <= cols) {
			line = `${line} ${word}`;
			continue;
		} else {
			flush();
			line = word;
		}
		// Hard-break a token that cannot fit its row on its own. The reset has to
		// come off before the slice: counting it as text would silently eat four
		// characters of the URL at every break.
		while (visibleWidth(line) > cols) {
			const chunk = withoutTrailingReset(truncateToWidth(line, cols, ""));
			if (!chunk) break;
			out.push(chunk);
			line = line.slice(chunk.length);
		}
	}
	flush();
	return out;
}

/** Wrap `text` into rows carrying `prefix` on the first row and `indent` after,
 * colorized per row (styles never survive a line break in the TUI). */
function wrapWithPrefix(
	text: string,
	width: number,
	prefix: string,
	indent: string,
	paint: (line: string) => string,
): string[] {
	const rows = wrapPlain(text, width - visibleWidth(indent));
	if (rows.length === 0) return [];
	return rows.map((row, i) => (i === 0 ? `${prefix}${paint(row)}` : `${indent}${paint(row)}`));
}

/**
 * Last-resort width clamp. A rendered line wider than the viewport makes
 * `TUI.doRender` throw and takes the process with it, so no row leaves this
 * module unmeasured — label plus scope alone can outgrow a very narrow terminal.
 */
function clampAll(lines: string[], width: number): string[] {
	return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line));
}

/**
 * Call line: label, optional scope, and the question on a single row. Answered
 * asks demote the whole row to context so the `❯` below it carries the block.
 */
export function renderAskCallLines(
	args: { question?: unknown; header?: unknown } | undefined,
	theme: Theme,
	width: number,
	answered = false,
): string[] {
	const rawQuestion = typeof args?.question === "string" ? args.question.trim() : "";
	const question = rawQuestion || "…";
	const scope = typeof args?.header === "string" ? args.header.trim() : "";
	// On a narrow terminal the scope is the first thing to go: the question is
	// what the row exists for, and a scope that eats the whole line helps nobody.
	// `·` rides tight against both sides, matching every other separator in the UI.
	const scopeLabel = scope && width - LABEL_COLS - visibleWidth(scope) - 1 >= MIN_QUESTION_COLS ? `${scope}·` : "";
	const avail = Math.max(1, width - LABEL_COLS - visibleWidth(scopeLabel));

	// A trailing parenthetical is the model's aside — split it off so it can be
	// dimmed, and so the clip eats it before it eats the actual question.
	const asideMatch = ASIDE_RE.exec(question);
	const core = asideMatch ? asideMatch[1] : question;
	const asideText = asideMatch ? asideMatch[2] : "";

	// Paint each span on its own. Wrapping already-colored text in another color
	// nests two escape runs, and the inner `\x1b[39m` reverts to the terminal
	// default rather than to the outer color — every span after the aside would
	// lose its tone.
	const clipped = clipPlain(core, avail);
	const body = answered ? theme.fg("muted", clipped) : theme.fg("text", clipped);
	const left = avail - visibleWidth(clipped) - 1;
	const aside = asideText && left >= MIN_ASIDE_COLS ? ` ${theme.fg("dim", clipPlain(asideText, left))}` : "";

	const label = answered ? theme.fg("dim", LABEL_TEXT) : theme.bold(theme.fg("accent", LABEL_TEXT));
	return clampAll([`${label} ${theme.fg("dim", scopeLabel)}${body}${aside}`], width);
}

/**
 * Result line(s): the decision. Each picked option gets its own row (a
 * comma-joined blob hid where one label ended and the next began), an attached
 * comment nests under it, and freeform answers render as typed.
 */
export function renderAskResultLines(
	details: AskToolDetails | undefined,
	fallbackText: string,
	theme: Theme,
	width: number,
): string[] {
	const paintAnswer = (line: string): string => theme.fg("text", line);
	const answerPrefix = `${theme.fg("gutterUser", ICON_ANSWER)} `;

	if (details?.cancelled) {
		return clampAll([`${theme.fg("muted", ICON_CANCELLED)} ${theme.fg("muted", "cancelled")}`], width);
	}

	const response = details?.response;
	const lines: string[] = [];

	if (response?.kind === "selection" && response.selections.length > 0) {
		for (const selection of response.selections) {
			const label = selection.trim();
			if (!label) continue;
			lines.push(...wrapWithPrefix(label, width, answerPrefix, ANSWER_INDENT, paintAnswer));
		}
		const comment = response.comment?.trim();
		if (comment) {
			lines.push(
				...wrapWithPrefix(comment, width, `${ANSWER_INDENT}${theme.fg("dim", NOTE_MARKER)}`, NOTE_INDENT, (line) =>
					theme.fg("dim", line),
				),
			);
		}
		return clampAll(lines, width);
	}

	if (response?.kind === "freeform" && response.text.trim()) {
		return clampAll(wrapWithPrefix(response.text.trim(), width, answerPrefix, ANSWER_INDENT, paintAnswer), width);
	}

	// Auto-answered / listener-less runs land here with only a text payload. They
	// get the neutral marker, not `❯` — nobody typed anything.
	const output = fallbackText.trim();
	if (!output) return [];
	return clampAll(
		wrapWithPrefix(output, width, `${theme.fg("dim", ICON_AUTO)} `, ANSWER_INDENT, (line) => theme.fg("dim", line)),
		width,
	);
}

/**
 * Width-aware line block for the two `ask` renderers. Rebuilds only when the
 * width or the caller's state key changes, and returns a fresh array only then
 * — the TUI detects "this child changed" by array identity, so a stable render
 * must hand back the same instance.
 */
export class AskLineBlock implements Component {
	private build: (width: number) => string[];
	private key: string;
	private memoWidth = -1;
	private memoKey: string | null = null;
	private memoLines: string[] | null = null;

	constructor(key: string, build: (width: number) => string[]) {
		this.key = key;
		this.build = build;
	}

	/** Point the block at new state. A same-key update is a no-op, so streaming
	 * arg deltas that do not change the rendered text cost nothing. */
	setState(key: string, build: (width: number) => string[]): void {
		this.build = build;
		if (key !== this.key) {
			this.key = key;
			this.memoLines = null;
		}
	}

	invalidate(): void {
		this.memoLines = null;
	}

	render(width: number): string[] {
		if (this.memoLines !== null && this.memoWidth === width && this.memoKey === this.key) {
			return this.memoLines;
		}
		const lines = this.build(Math.max(1, width));
		this.memoWidth = width;
		this.memoKey = this.key;
		this.memoLines = lines;
		return lines;
	}
}
