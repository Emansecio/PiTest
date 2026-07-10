import { Container, type SelectItem, SelectList, type SelectListLayoutOptions } from "@pit/tui";
import { getSelectListTheme } from "../theme/theme.ts";
import { SelectorCard } from "./selector-card.ts";

const SHOW_IMAGES_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

/**
 * Component that renders a show images selector with a rounded card frame
 */
export class ShowImagesSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void) {
		super();

		const items: SelectItem[] = [
			{ value: "yes", label: "Yes", description: "Show images inline in terminal" },
			{ value: "no", label: "No", description: "Show text placeholder instead" },
		];

		const card = new SelectorCard();
		this.selectList = new SelectList(items, 5, getSelectListTheme(), SHOW_IMAGES_SELECT_LIST_LAYOUT);
		this.selectList.setSelectedIndex(currentValue ? 0 : 1);

		this.selectList.onSelect = (item) => {
			onSelect(item.value === "yes");
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
