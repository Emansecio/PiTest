import { basename } from "node:path";
import { type Component, Container, getKeybindings, Spacer, Text, truncateToWidth } from "@pit/tui";
import type { TurnGroup } from "../../../core/file-snapshots.ts";
import { theme } from "../theme/theme.ts";
import { selectionCursor, themedScrollPositionHint } from "./keybinding-hints.ts";
import { SelectorCard } from "./selector-card.ts";

/**
 * Parse a snapshot stamp (`2026-07-17T12-30-45-123Z-<counter>-<rand>`) back into
 * epoch ms for relative-time display. Returns NaN on an unrecognized shape.
 */
function stampToEpochMs(stamp: string): number {
	const tIndex = stamp.indexOf("T");
	if (tIndex < 0) return NaN;
	const date = stamp.slice(0, tIndex);
	const timePart = stamp.slice(tIndex + 1).split("Z")[0]; // "12-30-45-123"
	const [hh, mm, ss, ms] = timePart.split("-");
	if (!hh || !mm || !ss) return NaN;
	return Date.parse(`${date}T${hh}:${mm}:${ss}.${ms ?? "000"}Z`);
}

function relativeTime(stamp: string): string {
	const ms = stampToEpochMs(stamp);
	if (Number.isNaN(ms)) return "recently";
	const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (secs < 5) return "just now";
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.round(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	return `${days}d ago`;
}

/** One-line label: `<relative time> · <n files> · <first file…>`. */
function turnLabel(turn: TurnGroup): string {
	const rel = relativeTime(turn.latestTimestamp);
	const n = turn.files.length;
	const filesWord = n === 1 ? "1 file" : `${n} files`;
	const first = turn.files.length > 0 ? basename(turn.files[0]) : "";
	const more = turn.files.length > 1 ? ` +${turn.files.length - 1} more` : "";
	return `${rel} · ${filesWord} · ${first}${more}`;
}

type Phase = "list" | "confirm";

class RewindList implements Component {
	private selectedIndex = 0;
	private phase: Phase = "list";
	public onConfirm?: (turnId: string) => void;
	public onCancel?: () => void;
	private maxVisible = 10;
	private turns: TurnGroup[];

	constructor(turns: TurnGroup[]) {
		this.turns = turns;
	}

	invalidate(): void {}

	private renderConfirm(width: number): string[] {
		const turn = this.turns[this.selectedIndex];
		const n = turn.files.length;
		const lines: string[] = [];
		lines.push(theme.fg("warning", theme.bold(`Restore ${n === 1 ? "1 file" : `${n} files`} to before this turn?`)));
		lines.push("");
		for (const file of turn.files.slice(0, 8)) {
			lines.push(theme.fg("muted", `  ${truncateToWidth(file, width - 2, "…", false)}`));
		}
		if (turn.files.length > 8) lines.push(theme.fg("muted", `  …and ${turn.files.length - 8} more`));
		lines.push("");
		lines.push(theme.fg("error", "This overwrites current file contents and cannot be undone."));
		lines.push(theme.fg("muted", "[Enter] restore   [Esc] cancel"));
		return lines;
	}

	render(width: number): string[] {
		if (this.turns.length === 0) {
			return [theme.fg("muted", "  No file changes recorded to rewind")];
		}
		if (this.phase === "confirm") return this.renderConfirm(width);

		const lines: string[] = [];
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.turns.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.turns.length);
		for (let i = startIndex; i < endIndex; i++) {
			const isSelected = i === this.selectedIndex;
			const cursor = selectionCursor(isSelected);
			const label = turnLabel(this.turns[i]);
			const truncated = truncateToWidth(label, width - 2, "…", isSelected);
			let line = cursor + (isSelected ? theme.bold(truncated) : truncated);
			if (isSelected) line = theme.bg("selectedBg", line);
			lines.push(line);
		}
		const scrollHint = themedScrollPositionHint(this.selectedIndex, this.turns.length, startIndex, endIndex);
		if (scrollHint) lines.push(scrollHint);
		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (this.turns.length === 0) {
			if (kb.matches(keyData, "tui.select.cancel") || kb.matches(keyData, "tui.select.confirm")) this.onCancel?.();
			return;
		}
		if (this.phase === "confirm") {
			if (kb.matches(keyData, "tui.select.confirm")) {
				this.onConfirm?.(this.turns[this.selectedIndex].turnId);
			} else if (kb.matches(keyData, "tui.select.cancel")) {
				this.phase = "list"; // back to the list rather than closing outright
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.turns.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.turns.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			this.phase = "confirm";
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel?.();
		}
	}
}

/** Selector for `/rewind`: pick a turn, confirm, restore all files it touched. */
export class RewindSelectorComponent extends Container {
	private list: RewindList;

	constructor(turns: TurnGroup[], onConfirm: (turnId: string) => void, onCancel: () => void) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Rewind file changes"), 1, 0));
		this.addChild(
			new Text(
				theme.fg("muted", "Select a turn to restore every file it touched to the state just before it began"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const card = new SelectorCard();
		card.addChild(new Spacer(1));
		this.list = new RewindList(turns);
		this.list.onConfirm = onConfirm;
		this.list.onCancel = onCancel;
		card.addChild(this.list);
		card.addChild(new Spacer(1));
		this.addChild(card);

		if (turns.length === 0) setTimeout(() => onCancel(), 100);
	}

	getList(): RewindList {
		return this.list;
	}
}
