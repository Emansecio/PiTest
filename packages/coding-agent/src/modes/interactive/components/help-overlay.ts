import type { Component, Focusable, SelectItem, SelectListTheme } from "@pit/tui";
import { Input, Markdown, type MarkdownTheme, matchesKey, SelectList, truncateToWidth } from "@pit/tui";
import type { SlashCommandHelpEntry } from "../../../core/slash-commands.ts";

export interface HelpOverlayTheme {
	title: (text: string) => string;
	hint: (text: string) => string;
}

/** Scrollable, dismissible help surface used by `/help`.
 *
 * It deliberately renders as an overlay component instead of appending a
 * transcript block. Help is reference material, so leaving the conversation
 * untouched makes repeated lookups cheap and preserves the user's place.
 */
export class HelpOverlay implements Component, Focusable {
	private _focused = false;
	private readonly markdown?: Markdown;
	private readonly theme: HelpOverlayTheme;
	private readonly onClose: () => void;
	private readonly getViewportRows: () => number;
	private readonly searchInput?: Input;
	private readonly commandList?: SelectList;
	private scrollOffset = 0;
	private lastViewport = 1;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.searchInput) this.searchInput.focused = value;
	}

	constructor(
		content: string | ReadonlyArray<SlashCommandHelpEntry>,
		markdownTheme: MarkdownTheme,
		theme: HelpOverlayTheme,
		onClose: () => void,
		getViewportRows: () => number = () => process.stdout.rows || 24,
	) {
		this.theme = theme;
		this.onClose = onClose;
		this.getViewportRows = getViewportRows;

		if (typeof content === "string") {
			this.markdown = new Markdown(content, 0, 0, markdownTheme);
			return;
		}

		const items: SelectItem[] = content
			.filter((command) => !command.hidden)
			.map((command) => ({
				value: command.name,
				label: `/${command.name}`,
				description: command.description,
				section: command.group ?? "Advanced",
				badge: command.badge,
				filterText: [command.name, command.description, command.group, command.badge].filter(Boolean).join(" "),
			}));
		const listTheme: SelectListTheme = {
			selectedPrefix: (text) => this.theme.title(text),
			selectedText: (text) => this.theme.title(text),
			description: (text) => this.theme.hint(text),
			scrollInfo: (text) => this.theme.hint(text),
			noMatch: (text) => this.theme.hint(text),
			section: (text) => this.theme.hint(text),
		};
		this.commandList = new SelectList(items, 8, listTheme, {
			emptyText: "No matching commands",
			filterText: (item) => item.filterText ?? `${item.value} ${item.description ?? ""}`,
		});
		// Help is a reference surface: Enter is intentionally a no-op rather than
		// dispatching a command while the overlay is open.
		this.commandList.onSelect = () => {};
		this.searchInput = new Input({
			placeholder: "Filter commands by name, description, group or origin",
			placeholderColor: (text) => this.theme.hint(text),
		});
	}

	invalidate(): void {
		this.markdown?.invalidate();
		this.commandList?.invalidate();
	}

	render(width: number): string[] {
		if (this.commandList && this.searchInput) {
			const bodyWidth = Math.max(1, width - 4);
			const maxVisible = Math.max(3, Math.min(15, Math.floor(this.getViewportRows() * 0.8) - 8));
			this.commandList.setMaxVisible(maxVisible);
			this.searchInput.focused = this._focused;
			const hint = truncateToWidth(
				"Type to filter \u00b7 \u2191\u2193 navigate \u00b7 Esc close",
				bodyWidth,
				"\u2026",
			);
			return [
				this.theme.title("Help \u00b7 slash commands"),
				"",
				...this.searchInput.render(bodyWidth),
				"",
				...this.commandList.render(bodyWidth),
				"",
				this.theme.hint(hint),
			];
		}

		const body = this.markdown?.render(Math.max(1, width - 4)) ?? [];
		const viewport = Math.max(1, Math.min(body.length, Math.floor(this.getViewportRows() * 0.8) - 4));
		this.lastViewport = viewport;
		const maxScroll = Math.max(0, body.length - viewport);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
		const visible = body.slice(this.scrollOffset, this.scrollOffset + viewport);
		const scrollHint =
			body.length > viewport
				? `\u2191\u2193 scroll (${this.scrollOffset + 1}\u2013${Math.min(body.length, this.scrollOffset + viewport)} of ${body.length}) \u00b7 Esc close`
				: "Esc close";
		return [
			this.theme.title("Help"),
			"",
			...visible,
			"",
			this.theme.hint(truncateToWidth(scrollHint, width, "\u2026")),
		];
	}

	handleInput(data: string): void {
		if (this.commandList && this.searchInput) {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				if (this.searchInput.getValue()) {
					this.searchInput.setValue("");
					this.commandList.setFilter("");
					return;
				}
				this.onClose();
				return;
			}
			if (
				matchesKey(data, "up") ||
				matchesKey(data, "down") ||
				matchesKey(data, "pageUp") ||
				matchesKey(data, "pageDown") ||
				matchesKey(data, "home") ||
				matchesKey(data, "end") ||
				matchesKey(data, "enter")
			) {
				this.commandList.handleInput(data);
				return;
			}
			this.searchInput.handleInput(data);
			this.commandList.setFilter(this.searchInput.getValue());
			return;
		}

		if (matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.scrollOffset += 1;
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - this.lastViewport);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollOffset += this.lastViewport;
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}
}
