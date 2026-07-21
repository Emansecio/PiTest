import {
	Container,
	type Focusable,
	type Input,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type TUI,
} from "@pit/tui";
import { getAvailableThemes, getSelectListTheme, theme } from "../theme/theme.ts";
import { SelectorShell } from "./selector-shell.ts";

const THEME_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
	emptyText: "No matching themes",
};

/**
 * Component that renders a theme selector: a fuzzy search over theme names with
 * live preview (onSelectionChange → onPreview), preselecting the current theme
 * and marking it with a green ✓.
 */
export class ThemeSelectorComponent extends Container implements Focusable {
	private selectList: SelectList;
	private shell: SelectorShell;
	private onPreview: (themeName: string) => void;

	get focused(): boolean {
		return this.shell.focused;
	}
	set focused(value: boolean) {
		this.shell.focused = value;
	}

	constructor(
		currentTheme: string,
		onSelect: (themeName: string) => void,
		onCancel: () => void,
		onPreview: (themeName: string) => void,
		tui?: TUI,
	) {
		super();
		this.onPreview = onPreview;

		const themes = getAvailableThemes();
		const themeItems: SelectItem[] = themes.map((name) => ({
			value: name,
			// Green ✓ marks the theme that was active when the selector opened.
			label: name === currentTheme ? `${name}${theme.fg("success", " ✓")}` : name,
		}));

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

		this.shell = new SelectorShell(this.selectList, {
			title: "Theme",
			search: true,
			onCancel,
			tui,
			// Mounted inside ComposerChrome via showSelector — one frame only.
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

	getSearchInput(): Input | undefined {
		return this.shell.getSearchInput();
	}
}
