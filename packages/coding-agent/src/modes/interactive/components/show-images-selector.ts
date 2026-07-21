import { Container, type Focusable, type SelectItem, SelectList, type SelectListLayoutOptions } from "@pit/tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { SelectorShell } from "./selector-shell.ts";

const SHOW_IMAGES_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
	emptyText: "No matching options",
	// Two-item list: keys 1–9 jump to and confirm an option.
	digitSelect: true,
};

/**
 * Component that renders a show-images selector with a rounded card frame. The
 * current value is marked with a green ✓; digit quick-select is enabled.
 */
export class ShowImagesSelectorComponent extends Container implements Focusable {
	private selectList: SelectList;
	private shell: SelectorShell;

	get focused(): boolean {
		return this.shell.focused;
	}
	set focused(value: boolean) {
		this.shell.focused = value;
	}

	constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void) {
		super();

		const check = theme.fg("success", " ✓");
		const items: SelectItem[] = [
			{ value: "yes", label: currentValue ? `Yes${check}` : "Yes", description: "Show images inline in terminal" },
			{ value: "no", label: !currentValue ? `No${check}` : "No", description: "Show text placeholder instead" },
		];

		this.selectList = new SelectList(items, 5, getSelectListTheme(), SHOW_IMAGES_SELECT_LIST_LAYOUT);
		this.selectList.setSelectedIndex(currentValue ? 0 : 1);

		this.selectList.onSelect = (item) => {
			onSelect(item.value === "yes");
		};
		this.selectList.onCancel = () => {
			onCancel();
		};

		this.shell = new SelectorShell(this.selectList, {
			title: "Show images",
			search: false,
			onCancel,
			embedded: true,
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
