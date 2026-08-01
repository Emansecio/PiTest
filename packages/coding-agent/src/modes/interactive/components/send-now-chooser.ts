/**
 * Inline, single-line chooser shown when the user presses Enter with text in the
 * composer while the agent is working (`isStreaming || isFusing`). Instead of
 * silently queuing, it offers three actions:
 *
 *   ▌ <message preview…>  ▸ Send now ◷ Queue ✗ Cancel  ←/→ ⏎
 *
 * - Send now  → deliver for immediate reading in the current turn (steer). Tools
 *               still running are cancelled so the step boundary — and with it
 *               the message — arrives now, not after a long tool finishes.
 * - Queue     → the previous behavior (followUp), delivered after the turn.
 * - Cancel    → close and return the text intact to the composer.
 *
 * Three presentation rules, each earning its place:
 *
 * 1. **The glyphs are the ones the outcome will wear.** `▸` and `◷` are exactly
 *    the `▸ Steer` / `◷ Queued` labels of the message this choice produces (see
 *    `system-message-glyphs.ts`), so the button pre-figures its own result
 *    instead of naming it in a private vocabulary.
 * 2. **No hint line.** It used to read "←/→ choose · enter confirm · esc cancel",
 *    but with three labelled buttons and one highlighted, "confirm" and "cancel"
 *    only restate what the row already shows. Navigation is the one affordance a
 *    highlight does not imply, so the whole line collapses into a trailing `←/→ ⏎`
 *    and the chooser stops costing a row of vertical space above the composer.
 * 3. **One space between buttons, no padding inside them.** Padding inside each
 *    button is invisible on the dim ones, so it reads as plain gap and doubles
 *    the distance between labels — a row that looks spaced out for the benefit of
 *    a background block only one button is wearing. Without it every button
 *    measures glyph + label whether selected or not, so the row still cannot
 *    shift on ←/→, and the highlight hugs its label. Two spaces are reserved for
 *    the boundaries between the three groups (preview · buttons · hint), which is
 *    what makes the single space inside the group read as "these belong together".
 *
 * The component holds the highlighted index and the message text, and renders a
 * single content line. Keyboard navigation and confirmation are driven
 * externally by interactive-mode's input listener, which keeps focus on the
 * editor so printable keystrokes flow straight through to it (an implicit
 * Cancel that keeps editing fluid). Mouse is the one input the component owns:
 * it is a `MouseTarget`, so the TUI's hit-test routes a click on one of its
 * buttons here, which selects that button and fires `onAction` — the listener
 * cannot do this, because it only sees the raw SGR sequence, not where it
 * landed. See `interactive-mode.ts`.
 */

import { type Component, type MouseEvent, type MouseTarget, truncateToWidth, visibleWidth } from "@pit/tui";
import { theme } from "../theme/theme.ts";

export type SendNowSelection = "send" | "queue" | "cancel";

interface ChooserAction {
	key: SendNowSelection;
	/** Width-1 glyph, matching the system-message label this choice results in. */
	glyph: string;
	label: string;
}

const ACTIONS: readonly ChooserAction[] = [
	{ key: "send", glyph: "▸", label: "Send now" },
	{ key: "queue", glyph: "◷", label: "Queue" },
	{ key: "cancel", glyph: "✗", label: "Cancel" },
];

/** Length budget for the message preview when the terminal is comfortably wide. */
const PREVIEW_MAX = 48;

/**
 * Below this the preview is dropped entirely rather than truncated. A two-column
 * `o…` identifies nothing and still costs the buttons the room they need to stay
 * whole — and the buttons are the part the user has to act on.
 */
const PREVIEW_MIN = 12;

/** Trailing affordance: the only thing the highlighted buttons do not already say. */
const NAV_HINT = "←/→ ⏎";

/** Gap between the preview, the button row and the nav hint. */
const GAP = "  ";

export class SendNowChooser implements Component, MouseTarget {
	/** Index into ACTIONS of the highlighted action; opens on "Send now". */
	private index = 0;
	private readonly text: string;
	// Column span [start, end) of each button in the last rendered frame, parallel
	// to ACTIONS. Spans depend on the render width (the preview yields space), so
	// they are recomputed every render and consumed by onMouse for hit-testing.
	private buttonSpans: { start: number; end: number }[] = [];

	/**
	 * Fired when a mouse press lands on a button (which also becomes the
	 * highlighted selection). Wired by interactive-mode to the same confirm path
	 * Enter uses, so a click and a keyboard confirm are indistinguishable.
	 */
	onAction: ((selection: SendNowSelection) => void) | undefined = undefined;

	constructor(text: string) {
		this.text = text.replace(/\s+/g, " ").trim();
	}

	getSelection(): SendNowSelection {
		return ACTIONS[this.index]?.key ?? "send";
	}

	next(): void {
		this.index = (this.index + 1) % ACTIONS.length;
	}

	prev(): void {
		this.index = (this.index - 1 + ACTIONS.length) % ACTIONS.length;
	}

	invalidate(): void {}

	/**
	 * Render the button row. Every entry measures exactly `glyph + label`, selected
	 * or not, so the row cannot shift as the highlight moves — and a single space
	 * joins them, because anything wider reads as a gap rather than a group.
	 */
	private renderButtons(): string {
		return ACTIONS.map((action, i) => {
			const label = `${action.glyph} ${action.label}`;
			if (i === this.index) return theme.bg("selectedBg", theme.fg("accent", theme.bold(label)));
			return theme.fg("dim", label);
		}).join(" ");
	}

	render(width: number): string[] {
		const buttons = this.renderButtons();
		const hint = theme.fg("dim", `${GAP}${NAV_HINT}`);
		// Mirrors the gutter of the user message this text is about to become.
		const marker = theme.fg("gutterUser", "▌");
		// The preview yields space to the buttons: they must always be readable, the
		// message is only a reminder of what is about to be sent. The fixed cost is
		// the marker, its trailing space, the button row and the nav hint.
		const fixed = 2 + visibleWidth(buttons) + visibleWidth(hint);
		const available = width - fixed - GAP.length;
		const previewWidth = available >= PREVIEW_MIN ? Math.min(PREVIEW_MAX, available) : 0;
		// The preview's ACTUAL width can be shorter than its budget (short message),
		// so the button spans below must measure the truncated text, not the budget.
		const previewText = previewWidth > 0 ? truncateToWidth(this.text, previewWidth, "…") : "";
		const preview = previewText ? `${theme.fg("muted", previewText)}${GAP}` : "";
		let col = 2 + (previewText ? visibleWidth(previewText) + GAP.length : 0);
		this.buttonSpans = ACTIONS.map((action) => {
			const start = col;
			col += 2 + visibleWidth(action.label); // glyph + space + label
			const span = { start, end: col };
			col += 1; // single space joining the buttons
			return span;
		});
		return [truncateToWidth(`${marker} ${preview}${buttons}${hint}`, width, "…")];
	}

	/**
	 * Left-press on a button selects it and fires {@link onAction}. Anything else
	 * (other buttons/rows, the preview, drags, releases) is declined so the TUI's
	 * unclaimed-press escape hatch — native terminal selection — keeps working.
	 */
	onMouse(ev: MouseEvent, _localRow: number, localCol: number): boolean {
		if (ev.type !== "press" || ev.button !== "left") return false;
		const hit = this.buttonSpans.findIndex((span) => localCol >= span.start && localCol < span.end);
		if (hit === -1) return false;
		this.index = hit;
		this.onAction?.(ACTIONS[hit]?.key ?? "cancel");
		return true;
	}
}
