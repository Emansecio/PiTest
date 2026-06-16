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

import { Container, truncateToWidth, visibleWidth } from "@pit/tui";

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
	// One-column glyph shown in the gutter of the FIRST line instead of the static
	// bar (e.g. a running spinner). Undefined keeps the steady `│`.
	private gutterSpinner: string | undefined;
	// Memoized assembled output (leading blank + gutter + label). Children are
	// still polled every frame — built-in components memoize internally and
	// return the same array instance when unchanged (Component render
	// contract) — so when width, every child's returned array reference, and
	// the decoration props all match the previous frame, the assembled lines
	// are byte-identical and the same array instance is returned (which in
	// turn lets the parent Container reuse its own flatten cache). The prop
	// setters bust this memo directly instead of calling invalidate(); see
	// setGutterColor for why invalidate() must never be triggered from them.
	private memoWidth = -1;
	private memoChildOutputs: string[][] | null = null;
	private memoLines: string[] | null = null;

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
	 * every render; calling `invalidate()` from here would recurse infinitely
	 * with subclasses whose own `invalidate()` override re-enters this setter
	 * (e.g. ToolExecutionComponent). A real change busts the render memo
	 * directly instead, so the next frame reassembles with the new color.
	 */
	setGutterColor(fn: ((text: string) => string) | undefined): void {
		const next = fn ?? identityColor;
		if (next !== this.gutterColor) {
			this.gutterColor = next;
			this.bustMemo();
		}
	}

	/** Update the label. No invalidate — same rationale as `setGutterColor`. */
	setLabel(label: string | undefined): void {
		if (label !== this.label) {
			this.label = label;
			this.bustMemo();
		}
	}

	/**
	 * Set a one-column glyph for the first line's gutter (a running spinner);
	 * pass `undefined` to restore the static bar. No invalidate — same rationale
	 * as `setGutterColor` (the shell reads it fresh on every render).
	 */
	setGutterSpinner(glyph: string | undefined): void {
		if (glyph !== this.gutterSpinner) {
			this.gutterSpinner = glyph;
			this.bustMemo();
		}
	}

	/** Toggle passthrough mode. No invalidate — same rationale as `setGutterColor`. */
	setShellDisabled(disabled: boolean): void {
		if (disabled !== this.shellDisabled) {
			this.shellDisabled = disabled;
			this.bustMemo();
		}
	}

	/**
	 * Toggle the leading blank line. The placement logic suppresses it when the
	 * previous chat block is also a tool/bash block, so consecutive tool calls
	 * stack tightly. No invalidate — same rationale as `setGutterColor`.
	 */
	setNoLeadingGap(noLeadingGap: boolean): void {
		if (noLeadingGap !== this.noLeadingGap) {
			this.noLeadingGap = noLeadingGap;
			this.bustMemo();
		}
	}

	/** Drop the memoized framed output (next render reassembles). */
	private bustMemo(): void {
		this.memoChildOutputs = null;
		this.memoLines = null;
	}

	override invalidate(): void {
		super.invalidate();
		this.bustMemo();
	}

	override render(width: number): string[] {
		if (this.shellDisabled) {
			// Passthrough: render children at full width with no decoration.
			// This is the `renderShell:"self"` path for tools that own their
			// entire visual; the shell must not impose ANY framing on them.
			return super.render(width);
		}

		const innerWidth = Math.max(1, width - SHELL_GUTTER_COLS);
		const children = this.children;
		const childOutputs = new Array<string[]>(children.length);
		const prevOutputs = this.memoChildOutputs;
		// Children are re-polled every frame; a child signals "I changed" by
		// returning a different array reference (Component render contract).
		let reusable =
			this.memoLines !== null &&
			this.memoWidth === width &&
			prevOutputs !== null &&
			prevOutputs.length === children.length;
		for (let i = 0; i < children.length; i++) {
			const lines = children[i].render(innerWidth);
			childOutputs[i] = lines;
			if (reusable && prevOutputs !== null && lines !== prevOutputs[i]) {
				reusable = false;
			}
		}
		if (reusable && this.memoLines !== null) {
			return this.memoLines;
		}

		// Memo miss: flatten the child outputs and assemble the framed lines.
		const childLines: string[] = [];
		for (const lines of childOutputs) {
			for (const line of lines) childLines.push(line);
		}

		let result: string[];
		if (childLines.length === 0) {
			// Empty content collapses the shell entirely so callers can decide
			// to "hide" a block by clearing its children, mirroring how
			// ToolExecutionComponent already collapses empty render output.
			result = [];
		} else {
			const barGutter = this.gutterColor(SHELL_GUTTER_CHAR);
			// The first line may show a running spinner glyph in place of the bar.
			const headGutter = this.gutterSpinner !== undefined ? this.gutterColor(this.gutterSpinner) : barGutter;
			result = [];

			if (!this.noLeadingGap) {
				result.push("");
			}

			for (let i = 0; i < childLines.length; i++) {
				let line = childLines[i];
				const hasLabel = i === 0 && this.label !== undefined && this.label.length > 0;
				if (hasLabel) {
					const labelText = `${BOLD_OPEN}${this.label}${BOLD_CLOSE}`;
					line = `${this.gutterColor(labelText)}  ${line}`;
				}
				let assembled = `${i === 0 ? headGutter : barGutter} ${line}`;
				// Children render at innerWidth and components like Text pad their
				// lines to full width with spaces — injecting the label in front
				// pushes the first line past `width`, and the host's clamp would
				// then dangle a lone `…` at the right border, far from the text.
				// Trim the invisible padding first; only genuinely overflowing
				// content earns an ellipsis, attached to where the text ends.
				if (hasLabel && visibleWidth(assembled) > width) {
					assembled = assembled.replace(/ +$/, "");
					if (visibleWidth(assembled) > width) {
						assembled = truncateToWidth(assembled, width, "…");
					}
				}
				result.push(assembled);
			}
		}

		this.memoWidth = width;
		this.memoChildOutputs = childOutputs;
		this.memoLines = result;
		return result;
	}
}
