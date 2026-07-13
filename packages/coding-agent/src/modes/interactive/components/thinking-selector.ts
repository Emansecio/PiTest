import type { ThinkingLevel } from "@pit/agent-core";
import { Container, type Focusable, type SelectItem, SelectList, type SelectListLayoutOptions } from "@pit/tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { SelectorShell } from "./selector-shell.ts";

const THINKING_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
	emptyText: "No matching options",
	// Short list: keys 1–9 jump to and confirm a level, with dim ordinal prefixes.
	digitSelect: true,
};

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning depth for the hardest problems",
	ultra: "Ultra mode — multi-agent acceleration beyond max",
};

/**
 * Component that renders a thinking level selector with a rounded card frame. No
 * search (the list is short); digit quick-select is enabled and the current
 * level is marked with a green ✓.
 */
export class ThinkingSelectorComponent extends Container implements Focusable {
	private selectList: SelectList;
	private shell: SelectorShell;

	get focused(): boolean {
		return this.shell.focused;
	}
	set focused(value: boolean) {
		this.shell.focused = value;
	}

	constructor(
		currentLevel: ThinkingLevel,
		availableLevels: ThinkingLevel[],
		onSelect: (level: ThinkingLevel) => void,
		onCancel: () => void,
	) {
		super();

		const thinkingLevels: SelectItem[] = availableLevels.map((level) => ({
			value: level,
			// Green ✓ marks the level that was active when the selector opened.
			label: level === currentLevel ? `${level}${theme.fg("success", " ✓")}` : level,
			description: LEVEL_DESCRIPTIONS[level],
		}));

		this.selectList = new SelectList(
			thinkingLevels,
			thinkingLevels.length,
			getSelectListTheme(),
			THINKING_SELECT_LIST_LAYOUT,
		);

		const currentIndex = availableLevels.indexOf(currentLevel);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value as ThinkingLevel);
		};
		this.selectList.onCancel = () => {
			onCancel();
		};

		this.shell = new SelectorShell(this.selectList, {
			title: "Thinking level",
			search: false,
			onCancel,
		});
		this.addChild(this.shell);
	}

	handleInput(keyData: string): void {
		this.shell.handleInput(keyData);
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
