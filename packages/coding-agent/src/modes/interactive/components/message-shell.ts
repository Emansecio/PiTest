/**
 * Unified shell for chat-area blocks (Leva 2 — partial migration: tool, bash,
 * diagnostics).
 *
 * Every chat block today has a different visual idiom — solid bg rows for
 * user/tool/compaction, a pair of `─` borders for bash, nothing for assistant
 * and diagnostics. The shell replaces all of these with ONE pattern: a
 * 1-column colored gutter character at the left, an optional bold bracketed
 * label on the first content line, and a single leading blank line between
 * consecutive blocks.
 *
 * Layout (per rendered child line):
 *
 *     │  content goes here…
 *     └─ gutter (2 cols: char + space). Per-role color via theme.fg("gutter*").
 *
 * For the first content line, an optional label is injected between gutter
 * and content:
 *
 *     │ [compaction]  Compacted from 142,300 tokens (ctrl+x to expand)
 *
 * Opt-out: `shellDisabled = true` makes render a passthrough — no gutter, no
 * label, no spacer. Used by tool definitions with `renderShell:"self"` (built-
 * in `edit` / `edit-hashline` and extension tools that own their full UI).
 *
 * Width math: shell eats 2 columns. Children render at `width - 2`. The label
 * on the first line consumes additional columns from inside the content area,
 * not from the gutter — same semantic as injecting a `[label]  ` prefix in
 * front of the first child line.
 *
 * The shell extends `Container` so subclasses can still pass `instanceof X`
 * checks in `interactive-mode.ts` (e.g. the `ToolExecutionComponent` ones for
 * `setShowImages` / `setImageWidthCells`).
 */

import { Container } from "@pit/tui";

/** Single character used for the left gutter. Thin vertical (`│`) per P3. */
export const SHELL_GUTTER_CHAR = "│";

/** Number of columns the shell decoration consumes at the left edge. */
export const SHELL_GUTTER_COLS = 2; // GUTTER_CHAR + space

export interface MessageShellOptions {
	/**
	 * Color function applied to the gutter character and the (bold) label.
	 * Pass `undefined` to leave both in the terminal default foreground —
	 * used for the assistant role to keep it as the "neutral reading area".
	 */
	gutterColor?: (text: string) => string;
	/**
	 * Optional label rendered on the first content line, in bold, in the same
	 * color as the gutter. Bracket your own label if you want brackets in the
	 * output (`"[compaction]"` produces `[compaction]`). Kept short.
	 */
	label?: string;
	/**
	 * When `true`, render passes children through verbatim — no gutter, no
	 * label, no leading blank. Used by `renderShell:"self"` tool definitions
	 * and by extension custom renderers that ship their own framing.
	 */
	shellDisabled?: boolean;
	/**
	 * When `true`, omit the leading blank line. Used by the first block in a
	 * chat (rare — most chats start with a user input, where a leading blank
	 * is harmless). Off by default.
	 */
	noLeadingGap?: boolean;
}

const BOLD_OPEN = "\x1b[1m";
const BOLD_CLOSE = "\x1b[22m";

/** Identity color — for assistant role and when no color is given. */
const identityColor = (text: string): string => text;

/**
 * Base class for every chat-block component. Adds gutter + label + leading
 * blank around the children's rendered lines, unless disabled.
 */
export class MessageShell extends Container {
	private gutterColor: (text: string) => string;
	private label: string | undefined;
	private shellDisabled: boolean;
	private noLeadingGap: boolean;

	constructor(options: MessageShellOptions = {}) {
		super();
		this.gutterColor = options.gutterColor ?? identityColor;
		this.label = options.label;
		this.shellDisabled = options.shellDisabled ?? false;
		this.noLeadingGap = options.noLeadingGap ?? false;
	}

	/**
	 * Swap the gutter color at runtime — used by ToolExecutionComponent to
	 * reflect pending → success / error state transitions. Mirrors
	 * `Box.setBgFn`: does NOT invalidate. The shell reads the color fresh on
	 * every render and there is no cache to bust; calling `invalidate()` from
	 * here would recurse infinitely with subclasses whose own `invalidate()`
	 * override re-enters this setter (e.g. ToolExecutionComponent).
	 */
	setGutterColor(fn: ((text: string) => string) | undefined): void {
		this.gutterColor = fn ?? identityColor;
	}

	/** Update the label. No invalidate — same rationale as `setGutterColor`. */
	setLabel(label: string | undefined): void {
		this.label = label;
	}

	/** Toggle passthrough mode. No invalidate — same rationale as `setGutterColor`. */
	setShellDisabled(disabled: boolean): void {
		this.shellDisabled = disabled;
	}

	override render(width: number): string[] {
		if (this.shellDisabled) {
			// Passthrough: render children at full width with no decoration.
			// This is the `renderShell:"self"` path for tools that own their
			// entire visual; the shell must not impose ANY framing on them.
			return super.render(width);
		}

		const innerWidth = Math.max(1, width - SHELL_GUTTER_COLS);
		const childLines: string[] = [];
		for (const child of this.children) {
			const lines = child.render(innerWidth);
			for (const line of lines) childLines.push(line);
		}
		if (childLines.length === 0) {
			// Empty content collapses the shell entirely so callers can decide
			// to "hide" a block by clearing its children, mirroring how
			// ToolExecutionComponent already collapses empty render output.
			return [];
		}

		const gutter = this.gutterColor(SHELL_GUTTER_CHAR);
		const result: string[] = [];

		if (!this.noLeadingGap) {
			result.push("");
		}

		for (let i = 0; i < childLines.length; i++) {
			let line = childLines[i];
			if (i === 0 && this.label !== undefined && this.label.length > 0) {
				const labelText = `${BOLD_OPEN}${this.label}${BOLD_CLOSE}`;
				line = `${this.gutterColor(labelText)}  ${line}`;
			}
			result.push(`${gutter} ${line}`);
		}

		return result;
	}
}
