import { fuzzyFilter } from "../fuzzy.ts";
import { getKeybindings } from "../keybindings.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.ts";
import { Input } from "./input.ts";

export interface SettingItem {
	/** Unique identifier for this setting */
	id: string;
	/** Display label (left side) */
	label: string;
	/**
	 * Optional section group. Consecutive items sharing a group render under a
	 * single header; the header repeats at the top of the scroll window so the
	 * active section is always labelled. Items are expected to be pre-sorted so
	 * each group is contiguous.
	 */
	group?: string;
	/** Optional description shown when selected */
	description?: string;
	/** Current value to display (right side) */
	currentValue: string;
	/** If provided, Enter/Space cycles through these values */
	values?: string[];
	/** If provided, Enter opens this submenu. Receives current value and done callback. */
	submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

export interface SettingsListTheme {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
	/** Optional full-row background for the selected item. */
	selectedBg?: (text: string) => string;
	/** Optional style for group section headers. Falls back to `hint`. */
	header?: (text: string) => string;
}

export interface SettingsListOptions {
	enableSearch?: boolean;
}

export class SettingsList implements Component {
	private items: SettingItem[];
	private filteredItems: SettingItem[];
	private theme: SettingsListTheme;
	private selectedIndex = 0;
	private maxVisible: number;
	private onChange: (id: string, newValue: string) => void;
	private onCancel: () => void;
	private searchInput?: Input;
	private searchEnabled: boolean;

	// Submenu state
	private submenuComponent: Component | null = null;
	private submenuItemIndex: number | null = null;

	// Alignment column width, derived from `items` labels. Recomputing this
	// with Math.max(...spread) on every render() is an O(items) allocation
	// (spread materializes an intermediate array) that reruns on every frame
	// the list is visible even though labels never change between renders.
	// Cached lazily and invalidated only when `items` itself changes.
	private maxLabelWidthCache: number | null = null;

	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		options: SettingsListOptions = {},
	) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.onChange = onChange;
		this.onCancel = onCancel;
		this.searchEnabled = options.enableSearch ?? false;
		if (this.searchEnabled) {
			this.searchInput = new Input();
		}
	}

	/** Update an item's currentValue */
	updateValue(id: string, newValue: string): void {
		const item = this.items.find((i) => i.id === id);
		if (item) {
			item.currentValue = newValue;
		}
	}

	invalidate(): void {
		this.maxLabelWidthCache = null;
		this.submenuComponent?.invalidate?.();
	}

	/** Max label width across `items`, clamped to 30 and memoized until `items` changes. */
	private getMaxLabelWidth(): number {
		if (this.maxLabelWidthCache === null) {
			let max = 0;
			for (const item of this.items) {
				const w = visibleWidth(item.label);
				if (w > max) max = w;
			}
			this.maxLabelWidthCache = Math.min(30, max);
		}
		return this.maxLabelWidthCache;
	}

	render(width: number): string[] {
		// If submenu is active, render it instead
		if (this.submenuComponent) {
			return this.submenuComponent.render(width);
		}

		return this.renderMainList(width);
	}

	private renderMainList(width: number): string[] {
		const lines: string[] = [];

		if (this.searchEnabled && this.searchInput) {
			lines.push(...this.searchInput.render(width));
			lines.push("");
		}

		if (this.items.length === 0) {
			lines.push(truncateToWidth(this.theme.hint("  No settings available"), width));
			if (this.searchEnabled) {
				this.addHintLine(lines, width);
			}
			return lines;
		}

		const displayItems = this.searchEnabled ? this.filteredItems : this.items;
		if (displayItems.length === 0) {
			lines.push(truncateToWidth(this.theme.hint("  No matching settings"), width));
			this.addHintLine(lines, width);
			return lines;
		}

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), displayItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, displayItems.length);

		// Calculate max label width for alignment
		const maxLabelWidth = this.getMaxLabelWidth();

		// Render visible items. Group headers render before the first visible item
		// of each group; `prevGroup` starts undefined so the header for whatever
		// group tops the scroll window is always shown, even mid-group.
		const headerFn = this.theme.header ?? this.theme.hint;
		let prevGroup: string | undefined;
		for (let i = startIndex; i < endIndex; i++) {
			const item = displayItems[i];
			if (!item) continue;

			if (item.group && item.group !== prevGroup) {
				lines.push(truncateToWidth(headerFn(`  ${item.group}`), width, ""));
			}
			prevGroup = item.group;

			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.cursor : "  ";
			const prefixWidth = visibleWidth(prefix);

			// Pad label to align values
			const labelPadded = item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
			const labelText = this.theme.label(labelPadded, isSelected);

			// Calculate space for value
			const separator = "  ";
			const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
			const valueMaxWidth = width - usedWidth - 2;

			const valueText = this.theme.value(truncateToWidth(item.currentValue, valueMaxWidth), isSelected);

			let row = truncateToWidth(prefix + labelText + separator + valueText, width);
			if (isSelected && this.theme.selectedBg) {
				const padded = row + " ".repeat(Math.max(0, width - visibleWidth(row)));
				row = this.theme.selectedBg(padded);
			}
			lines.push(row);
		}

		// Add scroll indicators if needed. ↑ shows items exist above the visible
		// window, ↓ shows items exist below — both on the same themed count line.
		if (startIndex > 0 || endIndex < displayItems.length) {
			const up = startIndex > 0 ? "↑" : " ";
			const down = endIndex < displayItems.length ? "↓" : " ";
			const scrollText = `  ${up}${down} (${this.selectedIndex + 1}/${displayItems.length})`;
			lines.push(this.theme.hint(truncateToWidth(scrollText, width - 2, "")));
		}

		// Add description for selected item
		const selectedItem = displayItems[this.selectedIndex];
		if (selectedItem?.description) {
			lines.push("");
			const wrappedDesc = wrapTextWithAnsi(selectedItem.description, width - 4);
			for (const line of wrappedDesc) {
				lines.push(this.theme.description(`  ${line}`));
			}
		}

		// Add hint
		this.addHintLine(lines, width);

		return lines;
	}

	handleInput(data: string): void {
		// If submenu is active, delegate all input to it
		// The submenu's onCancel (triggered by escape) will call done() which closes it
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}

		// Main list input handling
		const kb = getKeybindings();
		const displayItems = this.searchEnabled ? this.filteredItems : this.items;
		if (kb.matches(data, "tui.select.up")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? displayItems.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(data, "tui.select.down")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === displayItems.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (kb.matches(data, "tui.select.pageUp")) {
			// Jump one window toward the top, clamped (no wrap — matches SelectList).
			if (displayItems.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
		} else if (kb.matches(data, "tui.select.pageDown")) {
			// Jump one window toward the bottom, clamped (no wrap).
			if (displayItems.length === 0) return;
			this.selectedIndex = Math.min(displayItems.length - 1, this.selectedIndex + this.maxVisible);
		} else if (kb.matches(data, "tui.select.home")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = 0;
		} else if (kb.matches(data, "tui.select.end")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = displayItems.length - 1;
		} else if (kb.matches(data, "tui.select.confirm") || (!this.searchEnabled && data === " ")) {
			// Enter always activates. A bare space activates ONLY when search is off
			// (legacy toggle behaviour); with search on, space is a query character so
			// multi-word filters like "auto resize" work.
			this.activateItem();
		} else if (kb.matches(data, "tui.select.cancel")) {
			// Two-step Esc when searching: a non-empty filter is cleared first, and
			// only a second Esc (empty filter) closes. Mirrors SelectorShell /
			// model-selector so every selector behaves uniformly.
			if (this.searchEnabled && this.searchInput && this.searchInput.getValue().length > 0) {
				this.searchInput.setValue("");
				this.applyFilter("");
				return;
			}
			this.onCancel();
		} else if (this.searchEnabled && this.searchInput) {
			// Everything else is query text (spaces preserved). Input rejects control
			// characters itself, so no pre-strip is needed.
			this.searchInput.handleInput(data);
			this.applyFilter(this.searchInput.getValue());
		}
	}

	private activateItem(): void {
		const item = this.searchEnabled ? this.filteredItems[this.selectedIndex] : this.items[this.selectedIndex];
		if (!item) return;

		if (item.submenu) {
			// Open submenu, passing current value so it can pre-select correctly
			this.submenuItemIndex = this.selectedIndex;
			this.submenuComponent = item.submenu(item.currentValue, (selectedValue?: string) => {
				if (selectedValue !== undefined) {
					item.currentValue = selectedValue;
					this.onChange(item.id, selectedValue);
				}
				this.closeSubmenu();
			});
		} else if (item.values && item.values.length > 0) {
			// Cycle through values
			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + 1) % item.values.length;
			const newValue = item.values[nextIndex];
			item.currentValue = newValue;
			this.onChange(item.id, newValue);
		}
	}

	private closeSubmenu(): void {
		this.submenuComponent = null;
		// Restore selection to the item that opened the submenu
		if (this.submenuItemIndex !== null) {
			this.selectedIndex = this.submenuItemIndex;
			this.submenuItemIndex = null;
		}
	}

	private applyFilter(query: string): void {
		this.filteredItems = fuzzyFilter(this.items, query, (item) => item.label);
		this.selectedIndex = 0;
	}

	private addHintLine(lines: string[], width: number): void {
		lines.push("");
		lines.push(
			truncateToWidth(
				this.theme.hint(
					this.searchEnabled
						? "  Type to search · Enter/Space to change · Esc to cancel"
						: "  Enter/Space to change · Esc to cancel",
				),
				width,
			),
		);
	}
}
