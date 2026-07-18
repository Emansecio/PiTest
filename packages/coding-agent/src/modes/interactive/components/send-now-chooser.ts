/**
 * Inline, single-line chooser shown when the user presses Enter with text in the
 * composer while the agent is working (`isStreaming || isFusing`). Instead of
 * silently queuing, it offers three actions:
 *
 *   #1 <message preview…>   [Send now] [Queue] [Cancel]
 *
 * - Send now  → deliver for immediate reading in the current turn (steer).
 * - Queue     → the previous behavior (followUp), delivered after the turn.
 * - Cancel    → close and return the text intact to the composer.
 *
 * The component is purely presentational: it holds the highlighted index and the
 * message text, and renders one content line (plus a dim hint). Navigation and
 * confirmation are driven externally by interactive-mode's input listener, which
 * keeps focus on the editor so printable keystrokes flow straight through to it
 * (an implicit Cancel that keeps editing fluid). See `interactive-mode.ts`.
 */

import { type Component, truncateToWidth, visibleWidth } from "@pit/tui";
import { theme } from "../theme/theme.ts";

export type SendNowSelection = "send" | "queue" | "cancel";

interface ChooserAction {
	key: SendNowSelection;
	label: string;
}

const ACTIONS: readonly ChooserAction[] = [
	{ key: "send", label: "Send now" },
	{ key: "queue", label: "Queue" },
	{ key: "cancel", label: "Cancel" },
];

/** Length budget for the message preview when the terminal is comfortably wide. */
const PREVIEW_MAX = 48;

export class SendNowChooser implements Component {
	/** Index into ACTIONS of the highlighted action; opens on "Send now". */
	private index = 0;
	private readonly text: string;

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

	/** Render the buttons; the highlighted one gets the shared selectedBg idiom. */
	private renderButtons(): string {
		return ACTIONS.map((action, i) => {
			const label = `[${action.label}]`;
			if (i === this.index) return theme.bg("selectedBg", theme.fg("accent", theme.bold(label)));
			return theme.fg("dim", label);
		}).join(" ");
	}

	render(width: number): string[] {
		const buttons = this.renderButtons();
		const marker = theme.fg("accent", "#1");
		// The preview yields space to the buttons: they must always be readable, the
		// message is only a reminder of what is about to be sent.
		const reserved = visibleWidth(buttons) + visibleWidth(marker) + 4; // markers + gaps
		const previewWidth = Math.max(0, Math.min(PREVIEW_MAX, width - reserved));
		const preview = previewWidth > 0 ? theme.fg("muted", truncateToWidth(this.text, previewWidth, "…")) : "";
		const head = preview ? `${marker} ${preview}   ${buttons}` : `${marker}   ${buttons}`;
		const hint = theme.fg("dim", "←/→ choose · enter confirm · esc cancel");
		return [truncateToWidth(head, width, "…"), truncateToWidth(hint, width, "…")];
	}
}
