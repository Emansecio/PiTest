import type { ThinkingLevel } from "@pit/agent-core";
import { Container, type SelectItem, SelectList, type SelectListLayoutOptions } from "@pit/tui";
import { getSelectListTheme } from "../theme/theme.ts";
import { SelectorCard } from "./selector-card.ts";

const THINKING_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
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
 * Component that renders a thinking level selector with a rounded card frame
 */
export class ThinkingSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(
		currentLevel: ThinkingLevel,
		availableLevels: ThinkingLevel[],
		onSelect: (level: ThinkingLevel) => void,
		onCancel: () => void,
	) {
		super();

		const thinkingLevels: SelectItem[] = availableLevels.map((level) => ({
			value: level,
			label: level,
			description: LEVEL_DESCRIPTIONS[level],
		}));

		const card = new SelectorCard();
		this.selectList = new SelectList(
			thinkingLevels,
			thinkingLevels.length,
			getSelectListTheme(),
			THINKING_SELECT_LIST_LAYOUT,
		);

		const currentIndex = thinkingLevels.findIndex((item) => item.value === currentLevel);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value as ThinkingLevel);
		};

		this.selectList.onCancel = () => {
			onCancel();
		};

		card.addChild(this.selectList);
		this.addChild(card);
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
