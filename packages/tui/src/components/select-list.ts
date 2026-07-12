import { fuzzyFilter } from "../fuzzy.ts";
import { getKeybindings, type Keybinding } from "../keybindings.ts";
import { type KeyId, matchesKey } from "../keys.ts";
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
	/** Optional full-row background for the selected item. */
	selectedBg?: (text: string) => string;
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
	/**
	 * Message shown when the filter matches nothing. Defaults to "No matches".
	 * Exposed because the noun varies by consumer — a command palette wants "No
	 * matching commands" while a theme / thinking picker wants "No matches". The
	 * two-space indent used by every other row is applied for us, so pass the
	 * bare text.
	 */
	emptyText?: string;
	/**
	 * Opt-in digit quick-select. When true and the filtered list has ≤ 9 items,
	 * pressing "1".."9" jumps to that item AND confirms it (same as onSelect), and
	 * each visible row gains a dim ordinal prefix ("1", "2", …) so the mapping is
	 * discoverable. With more than 9 items the feature is inert — digits fall
	 * through and no ordinals are drawn — because single digits can no longer name
	 * every item unambiguously. Off by default to keep existing pickers unchanged.
	 */
	digitSelect?: boolean;
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

	/**
	 * Resize the visible window at runtime so consumers can adapt to terminal
	 * height. Clamped to a floor of 3 so the scroll math (which centers the
	 * selection with Math.floor(maxVisible / 2)) always has room to show context
	 * above and below the cursor. The constructor param remains the initial value.
	 */
	setMaxVisible(n: number): void {
		this.maxVisible = Math.max(3, Math.floor(n));
	}

	invalidate(): void {
		this.cachedColumnWidth = undefined;
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// If no items match filter, show message
		if (this.filteredItems.length === 0) {
			lines.push(this.theme.noMatch(`  ${this.layout.emptyText ?? "No matches"}`));
			return lines;
		}

		const primaryColumnWidth = this.getPrimaryColumnWidth();
		// Ordinals are only shown (and digits only actionable) when opt-in digit
		// select is on and the list is short enough for single digits to be unique.
		const showOrdinals = this.digitSelectActive();

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
			// Ordinal reflects the 1-based position in the filtered list so it lines
			// up with the digit that selects it, independent of the scroll window.
			const ordinal = showOrdinals ? i + 1 : undefined;
			lines.push(this.renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth, ordinal));
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
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.notifySelectionChange();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.notifySelectionChange();
		}
		// Page up - jump one window toward the top, clamped (no wrap). Unlike the
		// single-step arrows, paging past the edge simply parks at the boundary.
		else if (kb.matches(keyData, "tui.select.pageUp")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
			this.notifySelectionChange();
		}
		// Page down - jump one window toward the bottom, clamped (no wrap).
		else if (kb.matches(keyData, "tui.select.pageDown")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = Math.min(this.filteredItems.length - 1, this.selectedIndex + this.maxVisible);
			this.notifySelectionChange();
		}
		// Home - jump to the first item.
		else if (kb.matches(keyData, "tui.select.home")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = 0;
			this.notifySelectionChange();
		}
		// End - jump to the last item.
		else if (kb.matches(keyData, "tui.select.end")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.filteredItems.length - 1;
			this.notifySelectionChange();
		}
		// Digit quick-select (opt-in): "1".."9" jumps to and confirms that item.
		// Guarded so digits fall through untouched when the feature is off or the
		// list is too long for a unique mapping.
		else if (this.tryDigitSelect(keyData)) {
			// handled inside tryDigitSelect
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

	/**
	 * Whether digit quick-select is currently live: opt-in flag on, and few enough
	 * filtered items that single digits "1".."9" map uniquely. Centralized so the
	 * render (ordinals) and input (selection) paths agree on exactly one condition.
	 */
	private digitSelectActive(): boolean {
		return Boolean(this.layout.digitSelect) && this.filteredItems.length > 0 && this.filteredItems.length <= 9;
	}

	/**
	 * If digit quick-select is live and keyData is a digit naming a current item,
	 * select and confirm it. Returns true when it consumed the key so the caller
	 * can stop; false lets the key fall through (feature off, too many items, or a
	 * non-digit / out-of-range digit).
	 */
	private tryDigitSelect(keyData: string): boolean {
		if (!this.digitSelectActive()) return false;
		for (let n = 1; n <= this.filteredItems.length; n++) {
			if (matchesKey(keyData, String(n) as KeyId)) {
				this.selectedIndex = n - 1;
				const item = this.filteredItems[this.selectedIndex];
				if (item && this.onSelect) this.onSelect(item);
				return true;
			}
		}
		return false;
	}

	private renderItem(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		descriptionSingleLine: string | undefined,
		primaryColumnWidth: number,
		ordinal?: number,
	): string {
		const arrow = isSelected ? "→ " : "  ";
		// The ordinal sits between the arrow and the label. Its plain form ("1 ")
		// drives all width math; the display form dims it on unselected rows, while
		// selected rows are wrapped whole by selectedText/selectedBg below and so
		// use the plain form to avoid nested styling.
		const ordinalPlain = ordinal !== undefined ? `${ordinal} ` : "";
		const prefix = arrow + ordinalPlain;
		const prefixDisplay = isSelected || !ordinalPlain ? prefix : arrow + this.theme.description(ordinalPlain);
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
					return this.paintSelected(
						this.theme.selectedText(`${prefix}${truncatedValue}${spacing}${truncatedDesc}`),
						width,
					);
				}

				const descText = this.theme.description(spacing + truncatedDesc);
				return prefixDisplay + truncatedValue + descText;
			}
		}

		const maxWidth = width - prefixWidth - 2;
		const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth);
		if (isSelected) {
			return this.paintSelected(this.theme.selectedText(`${prefix}${truncatedValue}`), width);
		}

		return prefixDisplay + truncatedValue;
	}

	/** Pad selected row to width and apply optional selectedBg. */
	private paintSelected(line: string, width: number): string {
		if (!this.theme.selectedBg) {
			return line;
		}
		const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		return this.theme.selectedBg(padded);
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
