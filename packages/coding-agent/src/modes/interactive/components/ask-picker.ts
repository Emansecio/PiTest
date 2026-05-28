/**
 * Picker component for the `ask` tool. Renders a SelectList overlay so the
 * user can pick one (or several) of the tool-supplied options.
 *
 * Wiring: the interactive mode subscribes to the UserInputBus on session boot.
 * When a request arrives it constructs this picker, shows it as a selector,
 * and resolves the bus with the picked labels (or cancelled=true on ESC).
 */

import { Container, type SelectItem, SelectList, type SelectListLayoutOptions, Text } from "@earendil-works/pi-tui";
import type { AskOptionsRequest } from "../../../core/user-input-bus.ts";
import { theme as defaultTheme, getSelectListTheme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const ASK_PICKER_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 48,
};

const RECOMMENDED_BADGE = " (recommended)";

function formatLabel(req: AskOptionsRequest["options"][number]): string {
	return req.recommended ? `${req.label}${RECOMMENDED_BADGE}` : req.label;
}

export interface AskPickerResolveResult {
	picked: string[];
	cancelled: boolean;
}

/**
 * Factory that builds the picker container and a focusable SelectList.
 *
 * `onResolve` is invoked exactly once. Caller is responsible for tearing
 * down the overlay (typically via the `showSelector` `done` callback).
 */
export function createAskPicker(
	req: AskOptionsRequest,
	onResolve: (answer: AskPickerResolveResult) => void,
): { component: Container; focus: SelectList } {
	const container = new Container();

	// Optional header chip.
	if (req.header) {
		const chip = defaultTheme.fg("accent", `[${req.header}]`);
		container.addChild(new Text(chip, 1, 0));
	}

	// Question line.
	container.addChild(new Text(defaultTheme.bold(req.question), 1, 0));

	// Top border separator.
	container.addChild(new DynamicBorder());

	const items: SelectItem[] = req.options.map((opt, idx) => ({
		value: String(idx),
		label: formatLabel(opt),
		description: opt.description,
	}));

	const selectList = new SelectList(items, items.length, getSelectListTheme(), ASK_PICKER_LAYOUT);

	// Preselect the recommended option, if any.
	const recommendedIndex = req.options.findIndex((o) => o.recommended);
	if (recommendedIndex !== -1) {
		selectList.setSelectedIndex(recommendedIndex);
	}

	let settled = false;
	const settle = (result: AskPickerResolveResult) => {
		if (settled) return;
		settled = true;
		onResolve(result);
	};

	selectList.onSelect = (item) => {
		const idx = Number(item.value);
		const original = req.options[idx];
		const label = original?.label ?? item.label;
		settle({ picked: [label], cancelled: false });
	};
	selectList.onCancel = () => {
		settle({ picked: [], cancelled: true });
	};

	container.addChild(selectList);
	container.addChild(new DynamicBorder());

	return { component: container, focus: selectList };
}
