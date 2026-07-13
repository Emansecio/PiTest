/**
 * Picker component for the `ask` tool. Renders a full rounded card (same
 * `Card`/`cardBg` idiom as the model/config selectors — U01 full) containing
 * the question (with optional header chip and context), a list of options, an
 * optional freeform text field, and an optional toggleable comment field —
 * mirroring the `pi-ask-user` interaction model. Supports single-select,
 * multi-select (checkbox toggling), freeform typed answers, a comment attached
 * to a selection, and a live countdown when the request carries a timeout.
 *
 * Wiring: the interactive mode subscribes to the UserInputBus on session boot.
 * When a request arrives it constructs this picker (inline or as an overlay)
 * and resolves the bus with the picked labels, freeform text, and/or comment
 * (or cancelled=true on ESC at the top level).
 */

import {
	Card,
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

const RECOMMENDED_BADGE = " (recommended)";
const FREEFORM_ROW_LABEL = "✎ Other — type a custom answer…";
/** Detail connector under the focused option; continuations align to its text. */
const DESC_CONNECTOR = "   └─ ";
const DESC_CONTINUATION = "      ";
const COMMENT_PREFIX = "Note: ";
/** Max option rows rendered at once; window centers on the selected index. */
const MAX_VISIBLE_OPTIONS = 12;
/** Card frame + padding columns consumed around the body (│ + 1 pad each side). */
const CARD_CHROME_WIDTH = 4;

export interface AskPickerResolveResult {
	picked: string[];
	freeformText?: string;
	comment?: string;
	cancelled: boolean;
}

export interface AskPickerHooks {
	/** Toggle overlay visibility (no-op in inline mode). */
	onToggleVisibility?: () => void;
	/** Request a UI repaint (drives the live timeout countdown). */
	onRequestRender?: () => void;
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
 * Input. The body is string-rendered and framed by a real `Card` child adapter
 * so the frame (borders, cardBg, padding) is byte-identical to the other
 * selectors.
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
	/** Wall-clock deadline for the auto-answer timeout, if the request has one. */
	private readonly deadline: number | undefined;

	private readonly card: Card;
	/** Body lines computed per render; served to the Card via a child adapter. */
	private bodyLines: string[] = [];

	private mode: "list" | "freeform" | "comment" = "list";
	private index = 0;
	private readonly checked = new Set<number>();
	private input: Input | null = null;
	private commentInput: Input | null = null;
	private commentText = "";
	private settled = false;
	private tickTimer: ReturnType<typeof setTimeout> | undefined;

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
		this.deadline =
			typeof req.timeout === "number" && Number.isFinite(req.timeout) && req.timeout > 0
				? Date.now() + req.timeout
				: undefined;

		this.card = new Card(
			1,
			0,
			(s) => defaultTheme.bg("cardBg", s),
			(s) => defaultTheme.fg("cardBorder", s),
		);
		this.card.addChild({
			invalidate: () => {},
			render: () => this.bodyLines,
		});

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
		if (this.tickTimer) {
			clearTimeout(this.tickTimer);
			this.tickTimer = undefined;
		}
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
		this.card.invalidate();
		this.input?.invalidate();
		this.commentInput?.invalidate();
	}

	/**
	 * Header block INSIDE the card: optional scope chip, then the question —
	 * always, in both inline and overlay modes. The transcript's `ask …` call
	 * line may be scrolled away or truncated; the card is what the user is
	 * looking at, so it must carry the question.
	 */
	private renderQuestion(width: number, lines: string[]): void {
		const scope = this.req.header?.trim();
		const dot = defaultTheme.fg("accent", "●");
		if (scope) {
			lines.push(`${dot} ${defaultTheme.bold(scope)}`);
			for (const line of wrapPlain(this.req.question, width)) {
				lines.push(defaultTheme.bold(defaultTheme.fg("text", line)));
			}
		} else {
			// No chip: the question itself carries the accent dot.
			const qLines = wrapPlain(this.req.question, Math.max(1, width - 2));
			qLines.forEach((line, i) => {
				const body = defaultTheme.bold(defaultTheme.fg("text", line));
				lines.push(i === 0 ? `${dot} ${body}` : `  ${body}`);
			});
		}
		if (this.req.context) {
			lines.push(...renderSupplementaryContext(this.req.context, width));
		}
		lines.push("");
	}

	private checkboxPrefix(index: number): string {
		if (!this.allowMultiple) return "";
		const checked = this.checked.has(index);
		const glyph = checkboxGlyph(checked);
		const color = checked ? defaultTheme.fg("success", glyph) : defaultTheme.fg("dim", glyph);
		return `${color} `;
	}

	private renderList(width: number, lines: string[]): void {
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
			// The badge marks the default pick quietly: dim, never bold — the label
			// owns the row. Width reserved separately so clamping never eats it.
			const badge = opt.recommended ? defaultTheme.fg("dim", RECOMMENDED_BADGE) : "";
			const labelText = opt.recommended ? defaultTheme.bold(opt.label) : opt.label;
			const head =
				truncateToWidth(`${cursor}${box}${labelText}`, Math.max(0, width - visibleWidth(badge)), "…") + badge;
			// Full-width selectedBg on the focused row (same idiom as other selectors).
			lines.push(paintSelectedRow(focused ? defaultTheme.fg("accent", head) : head, width, focused));
			// Detail pane: ONLY the focused option shows its description, wrapped
			// under a └─ connector. Unfocused rows stay clean single-line labels —
			// the eye scans labels, the cursor reveals detail.
			const desc = opt.description?.replace(/\s+/g, " ").trim();
			if (focused && desc) {
				const descWidth = Math.max(10, width - DESC_CONTINUATION.length);
				wrapPlain(desc, descWidth).forEach((line, lineIdx) => {
					const prefix = lineIdx === 0 ? defaultTheme.fg("dim", DESC_CONNECTOR) : DESC_CONTINUATION;
					lines.push(`${prefix}${defaultTheme.fg("muted", line)}`);
				});
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
			// Breathing room separates the synthetic row from the model's options.
			if (this.options.length > 0) lines.push("");
			const head = `${selectionCursor(active)}${FREEFORM_ROW_LABEL}`;
			const styled = active ? defaultTheme.fg("accent", head) : defaultTheme.fg("muted", head);
			lines.push(paintSelectedRow(styled, width, active));
		}
	}

	/** Body (inside the card) for the current mode. */
	private renderBody(width: number): string[] {
		const lines: string[] = [];
		this.renderQuestion(width, lines);

		if (this.mode === "freeform" && this.input) {
			lines.push(defaultTheme.fg("dim", "Custom answer"));
			this.input.focused = this.focused;
			lines.push(...this.input.render(width));
			return lines;
		}

		this.renderList(width, lines);

		if (this.allowComment && this.commentText.trim() && this.mode === "list") {
			const prefix = `  ${COMMENT_PREFIX}`;
			const preview = truncateToWidth(this.commentText.trim(), Math.max(10, width - visibleWidth(prefix)), "…");
			lines.push(defaultTheme.fg("muted", prefix) + defaultTheme.fg("dim", preview));
		}

		if (this.mode === "comment" && this.commentInput) {
			lines.push("");
			lines.push(defaultTheme.fg("dim", "Add a note (optional)"));
			this.commentInput.focused = this.focused;
			lines.push(...this.commentInput.render(width));
		}

		return lines;
	}

	render(width: number): string[] {
		this.bodyLines = this.renderBody(Math.max(1, width - CARD_CHROME_WIDTH));
		const lines = this.card.render(width);
		lines.push(defaultTheme.fg("dim", `  ${this.hint()}`));
		this.scheduleCountdownTick();

		// Defensive final clamp: no rendered line may exceed `width`, or
		// TUI.doRender throws and crashes the process. The Card already clamps
		// its rows; this is the safety net for the hint line and any word too
		// long for wrapPlain to break (e.g. a long URL token).
		return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line));
	}

	/** Seconds left on the auto-answer timeout, or undefined when none. */
	private countdownSeconds(): number | undefined {
		if (this.deadline === undefined) return undefined;
		return Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
	}

	/**
	 * One-shot repaint scheduler for the countdown: re-arms itself via the next
	 * render. Harmless if the picker is torn down before it fires (one spare
	 * requestRender), and settle() clears it.
	 */
	private scheduleCountdownTick(): void {
		if (this.deadline === undefined || this.settled || this.tickTimer) return;
		if (!this.hooks.onRequestRender) return;
		this.tickTimer = setTimeout(() => {
			this.tickTimer = undefined;
			this.hooks.onRequestRender?.();
		}, 1_000);
		// Never keep the process alive for a repaint tick.
		(this.tickTimer as { unref?: () => void }).unref?.();
	}

	private hint(): string {
		const confirm = keyText("tui.select.confirm");
		const cancel = keyText("tui.select.cancel");
		let base: string;
		if (this.mode === "comment") {
			base = `${confirm} or ${this.commentToggleKey} to save${HINT_SEPARATOR}${cancel} ${LIST_CLOSE_LABEL}`;
		} else if (this.mode === "freeform") {
			base = `${confirm} submit${HINT_SEPARATOR}esc back`;
		} else {
			// Canonical shape shared with selectors: navigate · confirm select · cancel close
			const parts = [
				LIST_NAVIGATE_LABEL,
				this.allowMultiple
					? `space toggle${HINT_SEPARATOR}${confirm} ${LIST_SELECT_LABEL}`
					: `${confirm} ${LIST_SELECT_LABEL}`,
			];
			if (this.allowComment) parts.push(`${this.commentToggleKey} comment`);
			parts.push(`${cancel} ${LIST_CLOSE_LABEL}`);
			base = parts.join(HINT_SEPARATOR);
		}
		// Countdown LEADS the hint: on a narrow terminal the defensive clamp cuts
		// from the right, and the auto-select deadline is the one thing the user
		// must not lose.
		const remaining = this.countdownSeconds();
		if (remaining !== undefined) {
			base = `auto-selects in ${remaining}s${HINT_SEPARATOR}${base}`;
		}
		return base;
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
