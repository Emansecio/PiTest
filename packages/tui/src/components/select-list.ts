import { fuzzyFilter } from "../fuzzy.ts";
import { getKeybindings, type Keybinding } from "../keybindings.ts";
import type { KeyId } from "../keys.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

const normalizeToSingleLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

/** Pretty single-key label for a KeyId, e.g. "ctrl+r" → "Ctrl+R", "escape" → "Esc". */
function prettyKeyId(keyId: KeyId): string {
	const SPECIAL: Record<string, string> = {
		escape: "Esc",
		enter: "↵",
		return: "↵",
		tab: "Tab",
		up: "↑",
		down: "↓",
		left: "←",
		right: "→",
		space: "Space",
	};
	return keyId
		.split("+")
		.map((part) => {
			const lower = part.toLowerCase();
			if (SPECIAL[lower]) return SPECIAL[lower];
			if (/^[a-z]$/.test(part)) return part.toUpperCase();
			if (/^[a-z]+$/.test(part) && part.length > 1) return part.charAt(0).toUpperCase() + part.slice(1);
			return part;
		})
		.join("+");
}

/**
 * First configured key for a binding, rendered as a short label. Falls back to
 * `fallback` when the binding has no keys (e.g. a user cleared it) so the hint
 * still reads sensibly. Rebind-aware: reflects user overrides via getKeybindings().
 */
function keyHintLabel(binding: Keybinding, fallback: string): string {
	const keys = getKeybindings().getKeys(binding);
	const first = keys[0];
	return first ? prettyKeyId(first) : fallback;
}

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
}

export interface SelectListTruncatePrimaryContext {
	text: string;
	maxWidth: number;
	columnWidth: number;
	item: SelectItem;
	isSelected: boolean;
}

export interface SelectListLayoutOptions {
	minPrimaryColumnWidth?: number;
	maxPrimaryColumnWidth?: number;
	truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
	/**
	 * When true, render a trailing dim hint line spelling out how to accept /
	 * navigate / dismiss (e.g. "Tab/↵ aplicar · ↑↓ navegar · Esc fechar"). Only
	 * shown when more than one item is visible — with a single item Tab already
	 * auto-applies, so the hint would be noise. Off by default so the other
	 * SelectList consumers (model / session / theme pickers) stay uncluttered.
	 */
	showKeyHints?: boolean;
}

export class SelectList implements Component {
	private items: SelectItem[] = [];
	private filteredItems: SelectItem[] = [];
	private selectedIndex: number = 0;
	private maxVisible: number = 5;
	private theme: SelectListTheme;
	private layout: SelectListLayoutOptions;
	private cachedColumnWidth?: { length: number; firstValue: string; width: number };

	public onSelect?: (item: SelectItem) => void;
	public onCancel?: () => void;
	public onSelectionChange?: (item: SelectItem) => void;

	constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout: SelectListLayoutOptions = {}) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.layout = layout;
	}

	setFilter(filter: string): void {
		// Empty filter keeps the original order; otherwise rank by fuzzy match
		// quality (best first) and drop non-matches. fuzzyFilter lowercases and
		// caches per-item text internally, so no precomputed lowercase array is needed.
		this.filteredItems = filter.trim() ? fuzzyFilter(this.items, filter, (item) => item.value) : this.items;
		this.cachedColumnWidth = undefined;
		this.selectedIndex = 0;
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
	}

	invalidate(): void {
		this.cachedColumnWidth = undefined;
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// If no items match filter, show message
		if (this.filteredItems.length === 0) {
			lines.push(this.theme.noMatch("  No matching commands"));
			return lines;
		}

		const primaryColumnWidth = this.getPrimaryColumnWidth();

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const descriptionSingleLine = item.description ? normalizeToSingleLine(item.description) : undefined;
			lines.push(this.renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth));
		}

		// Add scroll indicators if needed. ↑ shows items exist above the visible
		// window, ↓ shows items exist below — both on the same themed count line.
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const up = startIndex > 0 ? "↑" : " ";
			const down = endIndex < this.filteredItems.length ? "↓" : " ";
			const scrollText = `  ${up}${down} (${this.selectedIndex + 1}/${this.filteredItems.length})`;
			// Truncate if too long for terminal
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
		}

		// Trailing key hint (opt-in). Only with >1 item: a lone item auto-applies
		// on Tab, so the hint would be redundant. Reuses the dim scrollInfo style.
		if (this.layout.showKeyHints && this.filteredItems.length > 1) {
			const hintLine = this.buildKeyHint(width);
			if (hintLine) lines.push(this.theme.scrollInfo(hintLine));
		}

		return lines;
	}

	/**
	 * Build the dim key-hint string, truncated to the available width. Returns ""
	 * when there isn't enough room to show even the truncated hint legibly.
	 */
	private buildKeyHint(width: number): string {
		const apply = `${keyHintLabel("tui.input.tab", "Tab")}/${keyHintLabel("tui.select.confirm", "↵")}`;
		const cancel = keyHintLabel("tui.select.cancel", "Esc");
		const hint = `  ${apply} apply · ↑↓ navigate · ${cancel} close`;
		const truncated = truncateToWidth(hint, width - 2, "…");
		// Below a tiny floor the hint is unreadable; suppress rather than show "…".
		return visibleWidth(truncated) >= 6 ? truncated : "";
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.notifySelectionChange();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.notifySelectionChange();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}

	private renderItem(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		descriptionSingleLine: string | undefined,
		primaryColumnWidth: number,
	): string {
		const prefix = isSelected ? "→ " : "  ";
		const prefixWidth = visibleWidth(prefix);

		if (descriptionSingleLine && width > 40) {
			const effectivePrimaryColumnWidth = Math.max(1, Math.min(primaryColumnWidth, width - prefixWidth - 4));
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			const truncatedValue = this.truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth);
			const truncatedValueWidth = visibleWidth(truncatedValue);
			const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			const remainingWidth = width - descriptionStart - 2; // -2 for safety

			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
				if (isSelected) {
					return this.theme.selectedText(`${prefix}${truncatedValue}${spacing}${truncatedDesc}`);
				}

				const descText = this.theme.description(spacing + truncatedDesc);
				return prefix + truncatedValue + descText;
			}
		}

		const maxWidth = width - prefixWidth - 2;
		const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth);
		if (isSelected) {
			return this.theme.selectedText(`${prefix}${truncatedValue}`);
		}

		return prefix + truncatedValue;
	}

	private getPrimaryColumnWidth(): number {
		const { min, max } = this.getPrimaryColumnBounds();
		const length = this.filteredItems.length;
		const firstValue = length > 0 ? this.filteredItems[0]!.value : "";
		const cached = this.cachedColumnWidth;
		if (cached && cached.length === length && cached.firstValue === firstValue) {
			return cached.width;
		}
		const widestPrimary = this.filteredItems.reduce((widest, item) => {
			return Math.max(widest, visibleWidth(this.getDisplayValue(item)) + PRIMARY_COLUMN_GAP);
		}, 0);
		const width = clamp(widestPrimary, min, max);
		this.cachedColumnWidth = { length, firstValue, width };
		return width;
	}

	private getPrimaryColumnBounds(): { min: number; max: number } {
		const rawMin =
			this.layout.minPrimaryColumnWidth ?? this.layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
		const rawMax =
			this.layout.maxPrimaryColumnWidth ?? this.layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;

		return {
			min: Math.max(1, Math.min(rawMin, rawMax)),
			max: Math.max(1, Math.max(rawMin, rawMax)),
		};
	}

	private truncatePrimary(item: SelectItem, isSelected: boolean, maxWidth: number, columnWidth: number): string {
		const displayValue = this.getDisplayValue(item);
		const truncatedValue = this.layout.truncatePrimary
			? this.layout.truncatePrimary({
					text: displayValue,
					maxWidth,
					columnWidth,
					item,
					isSelected,
				})
			: truncateToWidth(displayValue, maxWidth, "");

		return truncateToWidth(truncatedValue, maxWidth, "");
	}

	private getDisplayValue(item: SelectItem): string {
		return item.label || item.value;
	}

	private notifySelectionChange(): void {
		const selectedItem = this.filteredItems[this.selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	getSelectedItem(): SelectItem | null {
		const item = this.filteredItems[this.selectedIndex];
		return item || null;
	}
}
