/**
 * Shared "shell" for the simple in-place selectors (theme / thinking / show
 * images). Composes the rounded {@link SelectorCard}, an optional quiet title
 * line, an optional fuzzy search {@link Input}, and a {@link SelectList} using
 * the same Spacer(1) rhythm the model selector uses.
 *
 * The shell owns keyboard routing so every consumer gets identical semantics:
 * navigation / confirm / digit-select flow to the list, typing flows to the
 * search input, and Esc is two-step when searching (first clears the filter,
 * then closes). No key-hint footer — the SelectList scroll indicator is enough.
 */

import { Container, type Focusable, getKeybindings, Input, type SelectList, Spacer, Text, type TUI } from "@pit/tui";
import { theme } from "../theme/theme.ts";
import { SelectorCard } from "./selector-card.ts";

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

export interface SelectorShellOptions {
	/** Quiet one-line heading rendered above the list (e.g. "Theme"). */
	title?: string;
	/** When true, a fuzzy search Input is wired to `selectList.setFilter()`. */
	search?: boolean;
	/** Seed the search box (and the filter) with this value. Requires `search`. */
	initialSearch?: string;
	/** Invoked when Esc closes the selector (empty filter, or search disabled). */
	onCancel: () => void;
	/**
	 * When provided, the list's visible window adapts to terminal height:
	 * `clamp(rows - 12, 5, 15)`. Also used to request re-renders after input.
	 */
	tui?: TUI;
}

export class SelectorShell extends Container implements Focusable {
	private selectList: SelectList;
	private searchInput?: Input;
	private onCancelCallback: () => void;
	private tui?: TUI;

	// Focusable: propagate focus to the search input for IME cursor positioning,
	// mirroring ModelSelectorComponent.
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if (this.searchInput) this.searchInput.focused = value;
	}

	constructor(selectList: SelectList, options: SelectorShellOptions) {
		super();
		this.selectList = selectList;
		this.onCancelCallback = options.onCancel;
		this.tui = options.tui;

		// Adaptive height: leave ~12 rows for card chrome, title, search, editor and
		// scroll hint, clamped so the window is never tiny nor absurdly tall.
		if (this.tui) {
			this.selectList.setMaxVisible(clamp(this.tui.terminal.rows - 12, 5, 15));
		}

		const card = new SelectorCard();
		card.addChild(new Spacer(1));

		if (options.title) {
			// One quiet line — muted + bold, no extra chrome (post de-clutter pass).
			card.addChild(new Text(theme.bold(theme.fg("muted", options.title)), 0, 0));
			card.addChild(new Spacer(1));
		}

		if (options.search) {
			this.searchInput = new Input({
				placeholder: "Type to filter…",
				placeholderColor: (t) => theme.fg("dim", t),
			});
			if (options.initialSearch) {
				this.searchInput.setValue(options.initialSearch);
				this.selectList.setFilter(options.initialSearch);
			}
			card.addChild(this.searchInput);
			card.addChild(new Spacer(1));
		}

		card.addChild(this.selectList);
		card.addChild(new Spacer(1));
		// Uniform breathing room above the card (matches session/tree/config).
		this.addChild(new Spacer(1));
		this.addChild(card);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		// Esc / Ctrl+C. Two-step when searching: a non-empty filter is cleared
		// first, and only a second Esc (empty filter) closes the selector.
		if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.searchInput && this.searchInput.getValue().length > 0) {
				this.searchInput.setValue("");
				this.applyFilter();
				this.tui?.requestRender();
				return;
			}
			this.onCancelCallback();
			return;
		}

		// Navigation + confirm always flow to the list.
		if (
			kb.matches(keyData, "tui.select.up") ||
			kb.matches(keyData, "tui.select.down") ||
			kb.matches(keyData, "tui.select.pageUp") ||
			kb.matches(keyData, "tui.select.pageDown") ||
			kb.matches(keyData, "tui.select.home") ||
			kb.matches(keyData, "tui.select.end") ||
			kb.matches(keyData, "tui.select.confirm")
		) {
			this.selectList.handleInput(keyData);
			this.tui?.requestRender();
			return;
		}

		// No search box: hand everything else (incl. digit quick-select) to the list.
		if (!this.searchInput) {
			this.selectList.handleInput(keyData);
			this.tui?.requestRender();
			return;
		}

		// Search box present: the key is typed text — update the filter.
		this.searchInput.handleInput(keyData);
		this.applyFilter();
		this.tui?.requestRender();
	}

	/**
	 * Re-apply the search box value as the list filter and keep live preview in
	 * sync: setFilter resets selection to the top item without firing
	 * onSelectionChange, so we notify it here for consumers that preview the
	 * highlighted item (e.g. the theme selector) while filtering.
	 */
	private applyFilter(): void {
		if (!this.searchInput) return;
		this.selectList.setFilter(this.searchInput.getValue());
		const item = this.selectList.getSelectedItem();
		if (item) this.selectList.onSelectionChange?.(item);
	}

	getSelectList(): SelectList {
		return this.selectList;
	}

	getSearchInput(): Input | undefined {
		return this.searchInput;
	}
}
