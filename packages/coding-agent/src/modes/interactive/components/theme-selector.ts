import { Container, type SelectItem, SelectList, type SelectListLayoutOptions } from "@pit/tui";
import { getAvailableThemes, getSelectListTheme } from "../theme/theme.ts";
import { SelectorCard } from "./selector-card.ts";

const THEME_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

/**
 * Component that renders a theme selector
 */
export class ThemeSelectorComponent extends Container {
	private selectList: SelectList;
	private onPreview: (themeName: string) => void;

	constructor(
		currentTheme: string,
		onSelect: (themeName: string) => void,
		onCancel: () => void,
		onPreview: (themeName: string) => void,
	) {
		super();
		this.onPreview = onPreview;

		const themes = getAvailableThemes();
		const themeItems: SelectItem[] = themes.map((name) => ({
			value: name,
			label: name,
			description: name === currentTheme ? "(current)" : undefined,
		}));

		const card = new SelectorCard();
		this.selectList = new SelectList(themeItems, 10, getSelectListTheme(), THEME_SELECT_LIST_LAYOUT);

		const currentIndex = themes.indexOf(currentTheme);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = () => {
			onCancel();
		};

		this.selectList.onSelectionChange = (item) => {
			this.onPreview(item.value);
		};

		card.addChild(this.selectList);
		this.addChild(card);
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
