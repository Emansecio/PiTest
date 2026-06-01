/**
 * Picker component for the `ask` tool. Renders the question (with optional
 * context/header), a list of options, an optional freeform text field, and an
 * optional toggleable comment field — mirroring the `pi-ask-user` interaction
 * model. Supports single-select, multi-select (checkbox toggling), freeform
 * typed answers, and a comment attached to a selection.
 *
 * Wiring: the interactive mode subscribes to the UserInputBus on session boot.
 * When a request arrives it constructs this picker (inline or as an overlay)
 * and resolves the bus with the picked labels, freeform text, and/or comment
 * (or cancelled=true on ESC at the top level).
 */

import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	type KeyId,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@pit/tui";
import type { AskOptionsRequest } from "../../../core/user-input-bus.ts";
import { theme as defaultTheme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const RECOMMENDED_BADGE = " (recommended)";
const FREEFORM_ROW_LABEL = "✎ Type a custom answer…";

export interface AskPickerResolveResult {
	picked: string[];
	freeformText?: string;
	comment?: string;
	cancelled: boolean;
}

export interface AskPickerHooks {
	/** Toggle overlay visibility (no-op in inline mode). */
	onToggleVisibility?: () => void;
}

function wrapPlain(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const out: string[] = [];
	for (const rawLine of text.split("\n")) {
		let line = "";
		for (const word of rawLine.split(/\s+/)) {
			if (!word) continue;
			if (line === "") {
				line = word;
			} else if (visibleWidth(`${line} ${word}`) <= width) {
				line = `${line} ${word}`;
			} else {
				out.push(line);
				line = word;
			}
		}
		out.push(line);
	}
	return out;
}

/**
 * Stateful picker: a single focusable component that routes keystrokes to a
 * list view or, once the user enters the freeform/comment path, an inner text
 * Input.
 */
class AskPicker implements Component, Focusable {
	focused = false;

	private readonly req: AskOptionsRequest;
	private readonly onResolve: (answer: AskPickerResolveResult) => void;
	private readonly hooks: AskPickerHooks;
	private readonly options: AskOptionsRequest["options"];
	private readonly allowMultiple: boolean;
	private readonly allowFreeform: boolean;
	private readonly allowComment: boolean;
	private readonly overlayToggleKey: string;
	private readonly commentToggleKey: string;
	/** Row index of the synthetic "type a custom answer" entry, or -1. */
	private readonly freeformRow: number;

	private mode: "list" | "freeform" | "comment" = "list";
	private index = 0;
	private readonly checked = new Set<number>();
	private input: Input | null = null;
	private commentInput: Input | null = null;
	private commentText = "";
	private settled = false;

	constructor(
		req: AskOptionsRequest,
		onResolve: (answer: AskPickerResolveResult) => void,
		hooks: AskPickerHooks = {},
	) {
		this.req = req;
		this.onResolve = onResolve;
		this.hooks = hooks;
		this.options = req.options;
		this.allowMultiple = req.allowMultiple === true && req.options.length > 0;
		this.allowFreeform = req.allowFreeform === true;
		this.allowComment = req.allowComment === true && req.options.length > 0;
		this.overlayToggleKey = req.overlayToggleKey?.trim() || "alt+o";
		this.commentToggleKey = req.commentToggleKey?.trim() || "ctrl+g";
		this.freeformRow = this.allowFreeform ? this.options.length : -1;

		const recommendedIndex = this.options.findIndex((o) => o.recommended);
		if (recommendedIndex !== -1) {
			this.index = recommendedIndex;
		} else if (this.options.length === 0 && this.allowFreeform) {
			// Freeform-only prompt: drop straight into the text field.
			this.enterFreeform();
		}
	}

	private get rowCount(): number {
		return this.options.length + (this.allowFreeform ? 1 : 0);
	}

	private settle(result: AskPickerResolveResult): void {
		if (this.settled) return;
		this.settled = true;
		this.onResolve(result);
	}

	private enterFreeform(): void {
		this.mode = "freeform";
		const input = new Input();
		input.focused = true;
		input.onSubmit = (value: string) => {
			const text = value.trim();
			if (text === "") return; // don't submit an empty answer
			this.settle({ picked: [], freeformText: text, cancelled: false });
		};
		input.onEscape = () => {
			if (this.options.length === 0) {
				// No list to return to → ESC cancels the whole prompt.
				this.settle({ picked: [], cancelled: true });
				return;
			}
			this.mode = "list";
			this.input = null;
		};
		this.input = input;
	}

	private toggleComment(): void {
		if (this.mode === "comment") {
			this.commentText = this.commentInput?.getValue() ?? this.commentText;
			this.mode = "list";
			this.commentInput = null;
			return;
		}
		this.mode = "comment";
		const input = new Input();
		input.focused = true;
		input.setValue(this.commentText);
		const save = (value: string) => {
			this.commentText = value;
			this.mode = "list";
			this.commentInput = null;
		};
		input.onSubmit = save;
		input.onEscape = () => save(this.commentInput?.getValue() ?? this.commentText);
		this.commentInput = input;
	}

	private confirmList(): void {
		if (this.index === this.freeformRow) {
			this.enterFreeform();
			return;
		}
		const comment = this.commentText.trim() || undefined;
		if (this.allowMultiple) {
			const picked =
				this.checked.size > 0
					? [...this.checked].sort((a, b) => a - b).map((i) => this.options[i]?.label ?? "")
					: [this.options[this.index]?.label ?? ""];
			this.settle({ picked: picked.filter((l) => l !== ""), comment, cancelled: false });
			return;
		}
		const label = this.options[this.index]?.label;
		this.settle({ picked: label ? [label] : [], comment, cancelled: false });
	}

	handleInput(data: string): void {
		// Overlay visibility toggle works in any non-typing context.
		if (this.mode !== "freeform" && this.mode !== "comment" && matchesKey(data, this.overlayToggleKey as KeyId)) {
			this.hooks.onToggleVisibility?.();
			return;
		}
		// Comment toggle works from the list and closes the comment field.
		if (this.allowComment && matchesKey(data, this.commentToggleKey as KeyId)) {
			this.toggleComment();
			return;
		}

		if (this.mode === "freeform") {
			this.input?.handleInput(data);
			return;
		}
		if (this.mode === "comment") {
			this.commentInput?.handleInput(data);
			return;
		}

		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.index = this.index === 0 ? this.rowCount - 1 : this.index - 1;
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.index = this.index === this.rowCount - 1 ? 0 : this.index + 1;
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.confirmList();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.settle({ picked: [], cancelled: true });
			return;
		}
		// Space toggles a checkbox in multi-select mode (never on the freeform row).
		if (data === " " && this.allowMultiple && this.index < this.options.length) {
			if (this.checked.has(this.index)) this.checked.delete(this.index);
			else this.checked.add(this.index);
		}
	}

	invalidate(): void {
		this.input?.invalidate();
		this.commentInput?.invalidate();
	}

	private renderHeader(width: number, lines: string[]): void {
		if (this.req.header) {
			lines.push(defaultTheme.fg("accent", `[${this.req.header}]`));
		}
		lines.push(defaultTheme.bold(this.req.question));
		if (this.req.context) {
			for (const line of wrapPlain(this.req.context, width)) {
				lines.push(defaultTheme.fg("dim", line));
			}
		}
		lines.push(...new DynamicBorder().render(width));
	}

	private renderList(width: number, lines: string[]): void {
		for (let i = 0; i < this.options.length; i++) {
			const opt = this.options[i];
			if (!opt) continue;
			const cursor = i === this.index && this.mode === "list" ? "→ " : "  ";
			const box = this.allowMultiple ? (this.checked.has(i) ? "[x] " : "[ ] ") : "";
			const badge = opt.recommended ? RECOMMENDED_BADGE : "";
			const head = `${cursor}${box}${opt.label}${badge}`;
			const row = i === this.index && this.mode === "list" ? defaultTheme.fg("accent", head) : head;
			if (opt.description) {
				const desc = truncateToWidth(opt.description.replace(/\s+/g, " ").trim(), Math.max(10, width - 6), "");
				lines.push(`${row}  ${defaultTheme.fg("muted", desc)}`);
			} else {
				lines.push(row);
			}
		}

		if (this.allowFreeform) {
			const active = this.index === this.freeformRow && this.mode === "list";
			const head = `${active ? "→ " : "  "}${FREEFORM_ROW_LABEL}`;
			lines.push(active ? defaultTheme.fg("accent", head) : defaultTheme.fg("muted", head));
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		this.renderHeader(width, lines);

		if (this.mode === "freeform" && this.input) {
			this.input.focused = this.focused;
			lines.push(...this.input.render(width));
			lines.push(...new DynamicBorder().render(width));
			lines.push(defaultTheme.fg("dim", "  enter to submit · esc to go back"));
			return lines;
		}

		this.renderList(width, lines);

		if (this.allowComment && this.commentText.trim() && this.mode === "list") {
			const preview = truncateToWidth(this.commentText.trim(), Math.max(10, width - 14), "");
			lines.push(defaultTheme.fg("muted", `  ✎ comment: ${preview}`));
		}

		if (this.mode === "comment" && this.commentInput) {
			lines.push(...new DynamicBorder().render(width));
			lines.push(defaultTheme.fg("dim", "  Comment:"));
			this.commentInput.focused = this.focused;
			lines.push(...this.commentInput.render(width));
		}

		lines.push(...new DynamicBorder().render(width));
		lines.push(defaultTheme.fg("dim", `  ${this.hint()}`));
		return lines;
	}

	private hint(): string {
		if (this.mode === "comment") {
			return `enter or ${this.commentToggleKey} to save · esc to cancel`;
		}
		const parts = ["↑↓ move"];
		if (this.allowMultiple) parts.push("space to toggle", "enter to confirm");
		else parts.push("enter to choose");
		if (this.allowComment) parts.push(`${this.commentToggleKey} comment`);
		parts.push("esc to cancel");
		return parts.join(" · ");
	}
}

/**
 * Factory that builds the picker. `onResolve` is invoked exactly once. Caller
 * is responsible for tearing down the overlay (typically via the `showSelector`
 * `done` callback).
 */
export function createAskPicker(
	req: AskOptionsRequest,
	onResolve: (answer: AskPickerResolveResult) => void,
	hooks?: AskPickerHooks,
): { component: Component; focus: Component & Focusable } {
	const picker = new AskPicker(req, onResolve, hooks);
	return { component: picker, focus: picker };
}
