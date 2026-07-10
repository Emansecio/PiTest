/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import { Container, getKeybindings, Spacer, Text, type TUI } from "@pit/tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import {
	HINT_SEPARATOR,
	keyHint,
	LIST_CLOSE_LABEL,
	LIST_NAVIGATE_LABEL,
	LIST_SELECT_LABEL,
	selectionCursor,
	themedScrollPositionHint,
} from "./keybinding-hints.ts";
import { SelectableRow } from "./selectable-row.ts";
import { SelectorCard } from "./selector-card.ts";

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
}

const MAX_VISIBLE = 10;

export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		this.baseTitle = title;

		const card = new SelectorCard();
		card.addChild(new Spacer(1));

		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		card.addChild(this.titleText);
		card.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`))),
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new Container();
		card.addChild(this.listContainer);
		card.addChild(new Spacer(1));
		card.addChild(
			new Text(
				theme.fg("dim", LIST_NAVIGATE_LABEL) +
					HINT_SEPARATOR +
					keyHint("tui.select.confirm", LIST_SELECT_LABEL) +
					HINT_SEPARATOR +
					keyHint("tui.select.cancel", LIST_CLOSE_LABEL),
				1,
				0,
			),
		);
		card.addChild(new Spacer(1));
		this.addChild(card);

		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.options.length - MAX_VISIBLE),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE, this.options.length);

		for (let i = startIndex; i < endIndex; i++) {
			const isSelected = i === this.selectedIndex;
			const cursor = selectionCursor(isSelected);
			const label = isSelected ? theme.fg("accent", this.options[i]) : theme.fg("text", this.options[i]);
			this.listContainer.addChild(new SelectableRow(`${cursor}${label}`, isSelected, 1));
		}

		const scrollHint = themedScrollPositionHint(this.selectedIndex, this.options.length, startIndex, endIndex);
		if (scrollHint) {
			this.listContainer.addChild(new Text(scrollHint, 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
