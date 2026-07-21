/**
 * Unified Fusion setup: pick two advisors, see the synthesizer, toggle verify/brief.
 * Replaces the old sequential ExtensionSelector pair for `/fusion`.
 */

import { type Model, modelsAreEqual } from "@pit/ai";
import { Container, type Focusable, fuzzyFilter, getKeybindings, Input, Spacer, Text, type TUI } from "@pit/tui";
import { inferCli } from "../../../core/fusion/cli-runner.ts";
import type { FusionCli } from "../../../core/fusion/types.ts";
import { theme } from "../theme/theme.ts";
import {
	HINT_SEPARATOR,
	keyHint,
	LIST_CLOSE_LABEL,
	LIST_NAVIGATE_LABEL,
	selectionCursor,
	themedScrollPositionHint,
} from "./keybinding-hints.ts";
import { SelectableRow } from "./selectable-row.ts";
import { beginSelectorSurface } from "./selector-surface.ts";

const MAX_VISIBLE = 8;

export interface FusionAdvisorPick {
	cli: FusionCli;
	model: Model<any>;
}

export interface FusionSetupResult {
	advisors: [FusionAdvisorPick, FusionAdvisorPick];
	verify: boolean;
	brief: boolean;
}

/** Human-facing row label — prefer registry name when it adds information. */
export function modelRowLabel(model: Model<any>): string {
	const name = model.name?.trim();
	if (!name || name.toLowerCase() === model.id.toLowerCase()) return model.id;
	return name;
}

function modelSearchText(model: Model<any>): string {
	const name = model.name?.trim() ?? "";
	const cli = inferCli(model.provider) ?? "";
	return `${model.id} ${model.provider} ${name} ${cli}`;
}

function shortModelLabel(model: Model<any> | undefined): string {
	if (!model) return "—";
	return modelRowLabel(model);
}

/**
 * Single-card Fusion panel setup: synth (read-only) + two advisor slots + search
 * + verify/brief toggles.
 */
export class FusionSetupComponent extends Container implements Focusable {
	private searchInput: Input;
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private headerText: Text;
	private slotsText: Text;
	private togglesText: Text;
	private listContainer: Container;
	private hintText: Text;

	private candidates: Model<any>[] = [];
	private filtered: Model<any>[] = [];
	private selectedIndex = 0;
	private pickingSlot: 0 | 1 = 0;
	private slots: [Model<any> | undefined, Model<any> | undefined] = [undefined, undefined];
	private verify: boolean;
	private brief: boolean;

	private tui: TUI;
	private synthId: string;
	private onComplete: (result: FusionSetupResult) => void;
	private onCancel: () => void;

	constructor(
		tui: TUI,
		synthId: string,
		candidates: Model<any>[],
		initial: { verify: boolean; brief: boolean; panel?: Array<{ cli: string; model: string }> },
		onComplete: (result: FusionSetupResult) => void,
		onCancel: () => void,
	) {
		super();
		this.tui = tui;
		this.synthId = synthId;
		this.candidates = candidates;
		this.filtered = [...candidates];
		this.verify = initial.verify;
		this.brief = initial.brief;
		this.onComplete = onComplete;
		this.onCancel = onCancel;

		// Restore prior panel picks when ids still exist in the candidate list.
		if (initial.panel) {
			for (let i = 0; i < Math.min(2, initial.panel.length); i++) {
				const member = initial.panel[i];
				const match = candidates.find((m) => m.id === member.model && inferCli(m.provider) === member.cli);
				if (match) this.slots[i as 0 | 1] = match;
			}
			if (this.slots[0] && !this.slots[1]) this.pickingSlot = 1;
			else if (this.slots[0] && this.slots[1]) this.pickingSlot = 0;
		}

		const { surface: card, mount } = beginSelectorSurface(this, true);
		card.addChild(new Spacer(1));

		this.headerText = new Text(this.buildHeader(), 0, 0);
		card.addChild(this.headerText);
		card.addChild(new Spacer(1));

		this.slotsText = new Text(this.buildSlotsLine(), 0, 0);
		card.addChild(this.slotsText);

		this.togglesText = new Text(this.buildTogglesLine(), 0, 0);
		card.addChild(this.togglesText);
		card.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.searchInput.onSubmit = () => this.confirmSelection();
		card.addChild(this.searchInput);
		card.addChild(new Spacer(1));

		this.listContainer = new Container();
		card.addChild(this.listContainer);
		card.addChild(new Spacer(1));

		this.hintText = new Text(this.buildHint(), 0, 0);
		card.addChild(this.hintText);
		card.addChild(new Spacer(1));
		mount();

		this.updateList();
	}

	getSearchInput(): Input {
		return this.searchInput;
	}

	private buildHeader(): string {
		return (
			`${theme.fg("accent", theme.bold("Fusion setup"))}` +
			`\n${theme.fg("dim", `synth: ${this.synthId}  ·  change with /model`)}`
		);
	}

	private buildSlotsLine(): string {
		const a = shortModelLabel(this.slots[0]);
		const b = shortModelLabel(this.slots[1]);
		const mark = (slot: 0 | 1, label: string) => {
			const active = this.pickingSlot === slot;
			const filled = this.slots[slot] !== undefined;
			const prefix = active ? theme.fg("accent", "→") : " ";
			const body = active ? theme.fg("accent", label) : filled ? theme.fg("text", label) : theme.fg("dim", label);
			return `${prefix} ${slot + 1} ${body}`;
		};
		return `${theme.fg("muted", "advisors")}  ${mark(0, a)}  ${theme.fg("dim", "+")}  ${mark(1, b)}`;
	}

	private buildTogglesLine(): string {
		const onOff = (on: boolean) => (on ? theme.fg("success", "on") : theme.fg("dim", "off"));
		return (
			`${theme.fg("muted", "verify")} ${onOff(this.verify)}` +
			`${theme.fg("dim", "  ·  ")}` +
			`${theme.fg("muted", "brief")} ${onOff(this.brief)}` +
			`${theme.fg("dim", "  (v / b)")}`
		);
	}

	private buildHint(): string {
		const slotHint = `pick advisor ${this.pickingSlot + 1}`;
		return (
			theme.fg("dim", LIST_NAVIGATE_LABEL) +
			HINT_SEPARATOR +
			keyHint("tui.select.confirm", slotHint) +
			HINT_SEPARATOR +
			theme.fg("dim", "1/2 slot") +
			HINT_SEPARATOR +
			keyHint("tui.select.cancel", LIST_CLOSE_LABEL)
		);
	}

	private refreshChrome(): void {
		this.headerText.setText(this.buildHeader());
		this.slotsText.setText(this.buildSlotsLine());
		this.togglesText.setText(this.buildTogglesLine());
		this.hintText.setText(this.buildHint());
	}

	private filterModels(query: string): void {
		const q = query.trim();
		if (!q) {
			this.filtered = [...this.candidates];
		} else {
			this.filtered = fuzzyFilter(this.candidates, q, modelSearchText);
		}
		this.selectedIndex = 0;
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.filtered.length - MAX_VISIBLE),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE, this.filtered.length);

		let lastProvider = "";
		for (let i = startIndex; i < endIndex; i++) {
			const model = this.filtered[i];
			if (!model) continue;
			if (model.provider !== lastProvider) {
				lastProvider = model.provider;
				const cli = inferCli(model.provider);
				const header = cli ? `${model.provider} · ${cli}` : model.provider;
				this.listContainer.addChild(new Text(theme.fg("dim", `  ${header}`), 0, 0));
			}

			const isSelected = i === this.selectedIndex;
			const inSlot = this.slots.some((s) => s && modelsAreEqual(s, model));
			const label = modelRowLabel(model);
			const check = inSlot ? theme.fg("success", " ✓") : "";
			const cursor = selectionCursor(isSelected);
			const name = isSelected ? theme.fg("accent", label) : theme.fg("text", label);
			this.listContainer.addChild(new SelectableRow(`${cursor}${name}${check}`, isSelected));
		}

		const scrollHint = themedScrollPositionHint(this.selectedIndex, this.filtered.length, startIndex, endIndex);
		if (scrollHint) {
			this.listContainer.addChild(new Text(scrollHint, 0, 0));
		}

		if (this.filtered.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching CLI-backed models"), 0, 0));
		} else {
			const selected = this.filtered[this.selectedIndex];
			if (selected) {
				const cli = inferCli(selected.provider) ?? "?";
				this.listContainer.addChild(new Spacer(1));
				this.listContainer.addChild(
					new Text(theme.fg("dim", `  ${selected.provider}/${selected.id} · ${cli}`), 0, 0),
				);
			}
		}

		this.refreshChrome();
		this.tui.requestRender();
	}

	private confirmSelection(): void {
		const model = this.filtered[this.selectedIndex];
		if (!model) return;
		const cli = inferCli(model.provider);
		if (!cli) return;

		this.slots[this.pickingSlot] = model;

		if (this.slots[0] && this.slots[1]) {
			this.finish();
			return;
		}

		this.pickingSlot = this.slots[0] ? 1 : 0;
		this.updateList();
	}

	private finish(): void {
		const a = this.slots[0];
		const b = this.slots[1];
		if (!a || !b) return;
		const cliA = inferCli(a.provider);
		const cliB = inferCli(b.provider);
		if (!cliA || !cliB) return;
		this.onComplete({
			advisors: [
				{ cli: cliA, model: a },
				{ cli: cliB, model: b },
			],
			verify: this.verify,
			brief: this.brief,
		});
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
			return;
		}

		if (keyData === "v" || keyData === "V") {
			if (this.searchInput.getValue().length > 0) {
				this.searchInput.handleInput(keyData);
				this.filterModels(this.searchInput.getValue());
				return;
			}
			this.verify = !this.verify;
			this.refreshChrome();
			this.tui.requestRender();
			return;
		}

		if (keyData === "b" || keyData === "B") {
			if (this.searchInput.getValue().length > 0) {
				this.searchInput.handleInput(keyData);
				this.filterModels(this.searchInput.getValue());
				return;
			}
			this.brief = !this.brief;
			this.refreshChrome();
			this.tui.requestRender();
			return;
		}

		if (keyData === "1" && this.searchInput.getValue().length === 0) {
			this.pickingSlot = 0;
			this.updateList();
			return;
		}
		if (keyData === "2" && this.searchInput.getValue().length === 0) {
			this.pickingSlot = 1;
			this.updateList();
			return;
		}

		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			if (this.filtered.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			if (this.filtered.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.confirmSelection();
			return;
		}

		this.searchInput.handleInput(keyData);
		this.filterModels(this.searchInput.getValue());
	}
}
