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
 * With `frame: true`, tool blocks use a rounded card instead of the gutter:
 *
 *     ╭────────────────────────────────────╮
 *     │  content goes here…
 *     ╰────────────────────────────────────╯
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
 * Width math: unframed shell eats 2 columns. Framed shell eats 2 + 2×padding
 * (left/right borders plus inner padding each side; default padding 1 → 4 cols).
 * Children render at `width - overhead`. The label on the first line consumes
 * from inside the content area, not from the gutter — same semantic as
 * injecting a `[label]  ` prefix in front of the first child line.
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

/** Columns consumed by a rounded frame at default inner padding (1 each side). */
export const SHELL_FRAME_COLS = 4;

export interface MessageShellOptions {
	/**
	 * Color function applied to the gutter character and the (bold) label.
	 * Pass `undefined` to leave both in the terminal default foreground —
	 * used for the assistant role to keep it as the "neutral reading area".
	 */
	gutterColor?: (text: string) => string;
	/**
	 * Gutter glyph override (default `│`). The user role passes the heavier
	 * `▌` so "what I asked" is scannable by weight as well as color — color
	 * alone is a single 1-column signal shared with several other block types.
	 */
	gutterChar?: string;
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
	/**
	 * When `true`, wrap child lines in a rounded card (`╭─╮` / `│` / `╰─╯`)
	 * instead of the single-column gutter. Tool blocks opt in.
	 */
	frame?: boolean;
	/**
	 * Color for frame corners and rules when `frame` is true. Defaults to
	 * `gutterColor` when omitted.
	 */
	frameColor?: (text: string) => string;
	/**
	 * Inner horizontal padding inside a framed shell (default 1). Only used when
	 * `frame` is true.
	 */
	framePaddingX?: number;
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
	private gutterChar: string;
	private frameColor: (text: string) => string;
	private label: string | undefined;
	private shellDisabled: boolean;
	private noLeadingGap: boolean;
	private framed: boolean;
	private framePad: number;
	// One-column glyph shown in the gutter of the FIRST line instead of the static
	// bar (e.g. a running spinner). Undefined keeps the steady `│`. In framed
	// mode the spinner replaces the top-left corner (`╭`).
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
		this.gutterChar = options.gutterChar ?? SHELL_GUTTER_CHAR;
		this.frameColor = options.frameColor ?? options.gutterColor ?? identityColor;
		this.label = options.label;
		this.shellDisabled = options.shellDisabled ?? false;
		this.noLeadingGap = options.noLeadingGap ?? false;
		this.framed = options.frame ?? false;
		this.framePad = options.framePaddingX ?? 1;
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

	/** Toggle rounded card framing. No invalidate — same rationale as `setGutterColor`. */
	setFrame(framed: boolean): void {
		if (framed !== this.framed) {
			this.framed = framed;
			this.bustMemo();
		}
	}

	/** Update inner horizontal padding for framed mode. No invalidate — busts memo directly. */
	setFramePaddingX(padding: number): void {
		const next = Math.max(0, Math.min(3, Math.floor(padding)));
		if (next !== this.framePad) {
			this.framePad = next;
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

	private contentOverhead(): number {
		return this.framed ? this.frameOverhead() : SHELL_GUTTER_COLS;
	}

	private frameOverhead(): number {
		return 2 + this.framePad * 2;
	}

	private applyLabel(line: string): string {
		if (this.label === undefined || this.label.length === 0) {
			return line;
		}
		const labelText = `${BOLD_OPEN}${this.label}${BOLD_CLOSE}`;
		return `${this.gutterColor(labelText)}  ${line}`;
	}

	private renderFramed(width: number, childLines: string[]): string[] {
		const contentWidth = Math.max(1, width - this.frameOverhead());
		const rule = "─".repeat(Math.max(0, width - 2));
		const topLeft = this.gutterSpinner !== undefined ? this.gutterColor(this.gutterSpinner) : this.frameColor("╭");
		const top = `${topLeft}${this.frameColor(rule)}${this.frameColor("╮")}`;
		const bottom = this.frameColor(`╰${rule}╯`);
		const side = this.frameColor("│");
		const pad = " ".repeat(this.framePad);

		const result: string[] = [];
		if (!this.noLeadingGap) {
			result.push("");
		}
		result.push(truncateToWidth(top, width));

		for (let i = 0; i < childLines.length; i++) {
			let line = childLines[i];
			if (i === 0) {
				line = this.applyLabel(line);
			}
			const inner = truncateToWidth(line, contentWidth);
			const innerPad = " ".repeat(Math.max(0, contentWidth - visibleWidth(inner)));
			const assembled = `${side}${pad}${inner}${innerPad}${pad}${side}`;
			result.push(truncateToWidth(assembled, width));
		}

		result.push(truncateToWidth(bottom, width));
		return result;
	}

	private renderGuttered(width: number, childLines: string[]): string[] {
		const barGutter = this.gutterColor(this.gutterChar);
		const headGutter = this.gutterSpinner !== undefined ? this.gutterColor(this.gutterSpinner) : barGutter;
		const result: string[] = [];

		if (!this.noLeadingGap) {
			result.push("");
		}

		for (let i = 0; i < childLines.length; i++) {
			let line = childLines[i];
			const hasLabel = i === 0 && this.label !== undefined && this.label.length > 0;
			if (hasLabel) {
				line = this.applyLabel(line);
			}
			let assembled = `${i === 0 ? headGutter : barGutter} ${line}`;
			if (hasLabel && visibleWidth(assembled) > width) {
				assembled = assembled.replace(/ +$/, "");
				if (visibleWidth(assembled) > width) {
					assembled = truncateToWidth(assembled, width, "…");
				}
			}
			result.push(assembled);
		}
		return result;
	}

	override render(width: number): string[] {
		if (this.shellDisabled) {
			// Passthrough: render children at full width with no decoration.
			// This is the `renderShell:"self"` path for tools that own their
			// entire visual; the shell must not impose ANY framing on them.
			return super.render(width);
		}

		const innerWidth = Math.max(1, width - this.contentOverhead());
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
		} else if (this.framed) {
			result = this.renderFramed(width, childLines);
		} else {
			result = this.renderGuttered(width, childLines);
		}

		this.memoWidth = width;
		this.memoChildOutputs = childOutputs;
		this.memoLines = result;
		return result;
	}
}
