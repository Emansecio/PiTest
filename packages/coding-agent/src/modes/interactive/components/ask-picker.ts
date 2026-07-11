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
import { renderSupplementaryContext } from "./context-display.ts";
import {
	checkboxGlyph,
	HINT_SEPARATOR,
	keyText,
	LIST_CLOSE_LABEL,
	LIST_NAVIGATE_LABEL,
	LIST_SELECT_LABEL,
	selectionCursor,
} from "./keybinding-hints.ts";
import { paintSelectedRow } from "./selectable-row.ts";

const RECOMMENDED_BADGE = " · recommended";
const FREEFORM_ROW_LABEL = "Other — type custom answer…";
const OPTION_DESC_INDENT = "      ";
const COMMENT_PREFIX = "Note: ";
/** Max option rows rendered at once; window centers on the selected index. */
const MAX_VISIBLE_OPTIONS = 12;

function cardTopBorder(width: number): string {
	return defaultTheme.fg("cardBorder", `╭${"─".repeat(Math.max(0, width - 2))}╮`);
}

function cardBottomBorder(width: number): string {
	return defaultTheme.fg("cardBorder", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

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
	const pushHardBroken = (token: string): void => {
		let rest = token;
		while (visibleWidth(rest) > width) {
			const chunk = truncateToWidth(rest, width, "");
			if (!chunk) break;
			out.push(chunk);
			// Drop the visible prefix we just emitted (ANSI-free path for ask text).
			rest = rest.slice(chunk.length);
		}
		if (rest) out.push(rest);
	};
	for (const rawLine of text.split("\n")) {
		let line = "";
		for (const word of rawLine.split(/\s+/)) {
			if (!word) continue;
			if (visibleWidth(word) > width) {
				if (line) {
					out.push(line);
					line = "";
				}
				pushHardBroken(word);
				continue;
			}
			if (line === "") {
				line = word;
			} else if (visibleWidth(`${line} ${word}`) <= width) {
				line = `${line} ${word}`;
			} else {
				out.push(line);
				line = word;
			}
		}
		if (line) out.push(line);
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
		// Header matches the goal/todo overlay pattern: accent dot, bold label, em-dash, scope.
		const scope = this.req.header?.trim();
		const title = scope
			? `${defaultTheme.fg("accent", "●")} ${defaultTheme.bold("Ask")} ${defaultTheme.fg("dim", "—")} ${scope}`
			: `${defaultTheme.fg("accent", "●")} ${defaultTheme.bold("Ask")}`;
		lines.push(visibleWidth(title) > width ? truncateToWidth(title, width, "…") : title);

		// Inline pickers sit directly beneath the `ask` tool call line, which already
		// renders the question — repeating it here is pure vertical duplication. An
		// overlay covers the transcript, so it still needs to show the question.
		// Wrap it (never push raw) or a long single-line question overflows `width`
		// and crashes TUI.doRender.
		if ((this.req.displayMode ?? "inline") !== "inline") {
			// Overlay covers the transcript — question is the primary read; bold text
			// (not accent-on-everything) so options still own the accent scan.
			for (const line of wrapPlain(this.req.question, width)) {
				lines.push(defaultTheme.bold(defaultTheme.fg("text", line)));
			}
		}
		if (this.req.context) {
			lines.push(...renderSupplementaryContext(this.req.context, width));
		}
		lines.push(cardTopBorder(width));
	}

	private checkboxPrefix(index: number): string {
		if (!this.allowMultiple) return "";
		const checked = this.checked.has(index);
		const glyph = checkboxGlyph(checked);
		const color = checked ? defaultTheme.fg("success", glyph) : defaultTheme.fg("dim", glyph);
		return `${color} `;
	}

	private renderList(width: number, lines: string[]): void {
		if (this.options.length > 0) {
			const countLabel = this.options.length === 1 ? "1 option" : `${this.options.length} options`;
			lines.push(defaultTheme.fg("dim", countLabel));
		}

		const optionCount = this.options.length;
		let startIndex = 0;
		let endIndex = optionCount;
		if (optionCount > MAX_VISIBLE_OPTIONS) {
			// Center the window on the selected option (freeform row → last option).
			const selectedOptionIndex = this.index < optionCount ? this.index : Math.max(0, optionCount - 1);
			startIndex = Math.max(
				0,
				Math.min(selectedOptionIndex - Math.floor(MAX_VISIBLE_OPTIONS / 2), optionCount - MAX_VISIBLE_OPTIONS),
			);
			endIndex = Math.min(startIndex + MAX_VISIBLE_OPTIONS, optionCount);
		}

		for (let i = startIndex; i < endIndex; i++) {
			const opt = this.options[i];
			if (!opt) continue;
			const focused = i === this.index && this.mode === "list";
			const cursor = selectionCursor(focused);
			const box = this.checkboxPrefix(i);
			// Pre-color the badge (it marks the default pick) and reserve its width
			// separately, so clamping the head never eats into it.
			const badge = opt.recommended ? defaultTheme.fg("success", defaultTheme.bold(RECOMMENDED_BADGE)) : "";
			const labelText = opt.recommended ? defaultTheme.bold(opt.label) : opt.label;
			const head =
				truncateToWidth(`${cursor}${box}${labelText}`, Math.max(0, width - visibleWidth(badge)), "…") + badge;
			// U01: full-width selectedBg on the focused row (same idiom as other selectors).
			const row = paintSelectedRow(focused ? defaultTheme.fg("accent", head) : head, width, focused);
			const desc = opt.description?.replace(/\s+/g, " ").trim();
			if (focused && desc) {
				// Detail pane: the focused option shows its full description wrapped and
				// indented, so the choice under the cursor is never clipped — and the
				// recommended row (focused by default) no longer loses its description to
				// the badge eating the line width.
				lines.push(row);
				for (const line of wrapPlain(desc, Math.max(10, width - OPTION_DESC_INDENT.length))) {
					lines.push(defaultTheme.fg("muted", `${OPTION_DESC_INDENT}${line}`));
				}
			} else if (desc) {
				// Unfocused rows keep the description inline but clip with an ellipsis,
				// so a mid-word cut never reads as a finished sentence.
				const descBudget = width - visibleWidth(head) - 2;
				if (descBudget >= 10) {
					lines.push(`${row}  ${defaultTheme.fg("muted", truncateToWidth(desc, descBudget, "…"))}`);
				} else {
					lines.push(row);
				}
			} else {
				lines.push(row);
			}
		}

		if (startIndex > 0 || endIndex < optionCount) {
			const up = startIndex > 0 ? "↑" : " ";
			const down = endIndex < optionCount ? "↓" : " ";
			const scrollText = `  ${up}${down} (${this.index + 1}/${this.rowCount})`;
			lines.push(defaultTheme.fg("dim", truncateToWidth(scrollText, width, "")));
		}

		if (this.allowFreeform) {
			const active = this.index === this.freeformRow && this.mode === "list";
			const head = `${selectionCursor(active)}${FREEFORM_ROW_LABEL}`;
			const styled = active ? defaultTheme.fg("accent", head) : defaultTheme.fg("muted", head);
			lines.push(paintSelectedRow(styled, width, active));
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		this.renderHeader(width, lines);

		if (this.mode === "freeform" && this.input) {
			lines.push(defaultTheme.fg("dim", "Custom answer"));
			this.input.focused = this.focused;
			lines.push(...this.input.render(width));
			lines.push(""); // spacing instead of full-width ─ rule (U01)
			lines.push(defaultTheme.fg("dim", `  ${keyText("tui.select.confirm")} submit${HINT_SEPARATOR}esc back`));
		} else {
			this.renderList(width, lines);

			if (this.allowComment && this.commentText.trim() && this.mode === "list") {
				const prefix = `  ${COMMENT_PREFIX}`;
				const preview = truncateToWidth(this.commentText.trim(), Math.max(10, width - visibleWidth(prefix)), "…");
				lines.push(defaultTheme.fg("muted", prefix) + defaultTheme.fg("dim", preview));
			}

			if (this.mode === "comment" && this.commentInput) {
				lines.push(""); // spacing instead of full-width ─ rule (U01)
				lines.push(defaultTheme.fg("dim", "Add a note (optional)"));
				this.commentInput.focused = this.focused;
				lines.push(...this.commentInput.render(width));
			}

			lines.push(cardBottomBorder(width));
			lines.push(defaultTheme.fg("dim", `  ${this.hint()}`));
		}

		// Defensive final clamp: no rendered line may exceed `width`, or
		// TUI.doRender throws and crashes the process. Inputs/borders already
		// respect `width`; this is the safety net for the header/question and
		// any word too long for wrapPlain to break (e.g. a long URL token).
		return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line));
	}

	private hint(): string {
		const confirm = keyText("tui.select.confirm");
		const cancel = keyText("tui.select.cancel");
		if (this.mode === "comment") {
			return `${confirm} or ${this.commentToggleKey} to save${HINT_SEPARATOR}${cancel} ${LIST_CLOSE_LABEL}`;
		}
		// Canonical shape shared with selectors: navigate · confirm select · cancel close
		const parts = [
			LIST_NAVIGATE_LABEL,
			this.allowMultiple
				? `space toggle${HINT_SEPARATOR}${confirm} ${LIST_SELECT_LABEL}`
				: `${confirm} ${LIST_SELECT_LABEL}`,
		];
		if (this.allowComment) parts.push(`${this.commentToggleKey} comment`);
		parts.push(`${cancel} ${LIST_CLOSE_LABEL}`);
		return parts.join(HINT_SEPARATOR);
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
