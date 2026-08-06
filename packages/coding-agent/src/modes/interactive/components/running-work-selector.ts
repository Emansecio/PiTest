import { Container, getKeybindings, Spacer, Text, type TUI } from "@pit/tui";
import { theme } from "../theme/theme.ts";
import { HINT_SEPARATOR, keyHint, LIST_CLOSE_LABEL, LIST_NAVIGATE_LABEL, selectionCursor } from "./keybinding-hints.ts";
import { SelectableRow } from "./selectable-row.ts";
import { beginSelectorSurface } from "./selector-surface.ts";

export type RunningWorkItem = {
	kind: "foreground" | "background";
	id: string;
	label: string;
	state: string;
};

type RunningWorkAction = "view" | "interrupt" | "continue";

const ACTIONS: ReadonlyArray<{ key: RunningWorkAction; label: string }> = [
	{ key: "view", label: "View output" },
	{ key: "interrupt", label: "Interrupt and return output" },
	{ key: "continue", label: "Keep running" },
];

/**
 * Keyboard-first bridge between the composer and work already in flight.
 * The component owns selection only; InteractiveMode owns cancellation and
 * process lifecycle so this surface stays deterministic and cheap to test.
 */
export class RunningWorkSelectorComponent extends Container {
	private items: RunningWorkItem[] = [];
	private selectedIndex = 0;
	private actionIndex = 0;
	private level: "items" | "actions" = "items";
	private readonly listContainer: Container;
	private readonly getItems: () => RunningWorkItem[];
	private readonly onView: (item: RunningWorkItem) => void;
	private readonly onInterrupt: (item: RunningWorkItem) => void;
	private readonly onCancel: () => void;
	private readonly tui: TUI | undefined;
	private refreshTimer: NodeJS.Timeout | undefined;
	private closed = false;

	constructor(options: {
		getItems: () => RunningWorkItem[];
		onView: (item: RunningWorkItem) => void;
		onInterrupt: (item: RunningWorkItem) => void;
		onCancel: () => void;
		tui?: TUI;
	}) {
		super();
		this.getItems = options.getItems;
		this.onView = options.onView;
		this.onInterrupt = options.onInterrupt;
		this.onCancel = options.onCancel;
		this.tui = options.tui;

		const { surface: card, mount } = beginSelectorSurface(this, true);
		card.addChild(new Spacer(1));
		card.addChild(new Text(theme.bold(theme.fg("muted", "Running work")), 1, 0));
		card.addChild(new Spacer(1));
		this.listContainer = new Container();
		card.addChild(this.listContainer);
		card.addChild(new Spacer(1));
		card.addChild(
			new Text(
				theme.fg("dim", LIST_NAVIGATE_LABEL) +
					HINT_SEPARATOR +
					keyHint("tui.select.confirm", "select") +
					HINT_SEPARATOR +
					keyHint("tui.select.cancel", LIST_CLOSE_LABEL),
				1,
				0,
			),
		);
		card.addChild(new Spacer(1));
		mount();

		this.refresh();
		this.refreshTimer = setInterval(() => {
			this.refresh();
			this.tui?.requestRender();
		}, 1000);
		this.refreshTimer.unref?.();
	}

	private refresh(): void {
		const selectedItem = this.items[this.selectedIndex];
		this.items = this.getItems();
		if (selectedItem) {
			const nextIndex = this.items.findIndex(
				(item) => item.kind === selectedItem.kind && item.id === selectedItem.id,
			);
			if (nextIndex >= 0) {
				this.selectedIndex = nextIndex;
			} else if (this.level === "actions") {
				// The action menu belongs to a concrete command identity, not to a row
				// index. If that command finishes, never inherit the armed action onto
				// whichever command moved into the same position.
				this.level = "items";
				this.actionIndex = 0;
			}
		}
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.items.length - 1));
		if (this.level === "actions" && !this.items[this.selectedIndex]) this.level = "items";
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		if (this.items.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "No running commands"), 1, 0));
			return;
		}

		if (this.level === "actions") {
			const item = this.items[this.selectedIndex]!;
			this.listContainer.addChild(
				new Text(theme.fg("muted", `${item.kind === "background" ? item.id : "foreground"} · ${item.label}`), 1, 0),
			);
			for (let i = 0; i < ACTIONS.length; i++) {
				const action = ACTIONS[i]!;
				const selected = i === this.actionIndex;
				this.listContainer.addChild(
					new SelectableRow(
						`${selectionCursor(selected)}${theme.fg(selected ? "accent" : "text", action.label)}`,
						selected,
						1,
						() => this.handleActionClick(i),
					),
				);
			}
			return;
		}

		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			const selected = i === this.selectedIndex;
			const kind = item.kind === "background" ? item.id : "foreground";
			const row = `${selectionCursor(selected)}${theme.fg(selected ? "accent" : "muted", kind)}${theme.fg("dim", " · ")}${theme.fg(selected ? "accent" : "text", item.label)}${theme.fg("dim", ` · ${item.state}`)}`;
			this.listContainer.addChild(new SelectableRow(row, selected, 1, () => this.handleItemClick(i)));
		}
	}

	private handleItemClick(index: number): void {
		if (index !== this.selectedIndex) {
			this.selectedIndex = index;
			this.updateList();
			return;
		}
		this.openActions();
	}

	private handleActionClick(index: number): void {
		if (index !== this.actionIndex) {
			this.actionIndex = index;
			this.updateList();
			return;
		}
		this.confirmAction();
	}

	private openActions(): void {
		if (!this.items[this.selectedIndex]) return;
		this.level = "actions";
		this.actionIndex = 0;
		this.updateList();
	}

	private confirmAction(): void {
		const item = this.items[this.selectedIndex];
		const action = ACTIONS[this.actionIndex];
		if (!item || !action) return;
		this.close();
		if (action.key === "view") this.onView(item);
		else if (action.key === "interrupt") this.onInterrupt(item);
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.onCancel();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const up = kb.matches(keyData, "tui.select.up") || keyData === "k";
		const down = kb.matches(keyData, "tui.select.down") || keyData === "j";
		const confirm = kb.matches(keyData, "tui.select.confirm") || keyData === "\n";

		if (this.level === "actions") {
			if (up) {
				this.actionIndex = this.actionIndex === 0 ? ACTIONS.length - 1 : this.actionIndex - 1;
				this.updateList();
			} else if (down) {
				this.actionIndex = (this.actionIndex + 1) % ACTIONS.length;
				this.updateList();
			} else if (confirm) {
				this.confirmAction();
			} else if (kb.matches(keyData, "tui.select.cancel")) {
				this.level = "items";
				this.updateList();
			}
			return;
		}

		if (up) {
			if (this.items.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (down) {
			if (this.items.length === 0 || this.selectedIndex >= this.items.length - 1) {
				this.close();
				return;
			}
			this.selectedIndex += 1;
			this.updateList();
		} else if (confirm) {
			this.openActions();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.close();
		}
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}
}
