import { type Model, modelsAreEqual } from "@pit/ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	Text,
	TruncatedText,
	type TUI,
} from "@pit/tui";
import type { ModelRegistry } from "../../../core/model-registry.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

function modelKey(item: Pick<ModelItem, "provider" | "id">): string {
	return `${item.provider}/${item.id}`;
}

/** Human-facing row label — prefer registry name when it adds information. */
function modelRowLabel(model: Model<any>): string {
	const name = model.name?.trim();
	if (!name || name.toLowerCase() === model.id.toLowerCase()) return model.id;
	return name;
}

function modelSearchText(item: ModelItem): string {
	const name = item.model.name?.trim() ?? "";
	return `${item.id} ${item.provider} ${name} ${item.provider}/${item.id}`;
}

/**
 * Component that renders a model selector with search.
 *
 * When the session was started with `--models`, those entries form a pinned
 * "cycle set" at the top (what Ctrl+P rotates through). The rest of the
 * configured models follow in one searchable list — no all/scoped toggle.
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private cycleModelItems: ModelItem[] = [];
	private cycleKeySet = new Set<string>();
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedIndex: number = 0;
	private currentModel?: Model<any>;
	private settingsManager: SettingsManager;
	private modelRegistry: ModelRegistry;
	private onSelectCallback: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private headerHintText?: Text;

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		settingsManager: SettingsManager,
		modelRegistry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.settingsManager = settingsManager;
		this.modelRegistry = modelRegistry;
		this.scopedModels = scopedModels;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.headerHintText = new Text(this.getHeaderHintText(), 0, 0);
		this.addChild(this.headerHintText);
		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			// Enter on search input selects the first filtered item
			if (this.filteredModels[this.selectedIndex]) {
				this.handleSelect(this.filteredModels[this.selectedIndex].model);
			}
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Load models and do initial render
		this.loadModels().then(() => {
			if (initialSearchInput) {
				this.filterModels(initialSearchInput);
			} else {
				this.updateList();
			}
			// Request re-render after models are loaded
			this.tui.requestRender();
		});
	}

	private getHeaderHintText(): string {
		if (this.cycleModelItems.length > 0) {
			const count = this.cycleModelItems.length;
			const noun = count === 1 ? "model" : "models";
			const cycleHint = keyHint("app.model.cycleForward", "cycles the set");
			return (
				`${theme.fg("accent", "●")} ${theme.bold("Cycle set")} ${theme.fg("dim", "—")} ` +
				`${theme.fg("muted", `${count} ${noun}`)} ${theme.fg("dim", "·")} ${cycleHint}` +
				`\n${theme.fg("muted", "Search below picks any configured model.")}`
			);
		}
		return theme.fg("muted", "Only showing models from configured providers. Use /login to add providers.");
	}

	private async loadModels(): Promise<void> {
		let models: ModelItem[];

		// Refresh to pick up any changes to models.json
		this.modelRegistry.refresh();

		// Check for models.json errors
		const loadError = this.modelRegistry.getError();
		if (loadError) {
			this.errorMessage = loadError;
		}

		// Load available models (built-in models still work even if models.json failed)
		try {
			const availableModels = await this.modelRegistry.getAvailable();
			models = availableModels.map((model: Model<any>) => ({
				provider: model.provider,
				id: model.id,
				model,
			}));
		} catch (error) {
			this.allModels = [];
			this.cycleModelItems = [];
			this.cycleKeySet = new Set();
			this.activeModels = [];
			this.filteredModels = [];
			this.errorMessage = error instanceof Error ? error.message : String(error);
			if (this.headerHintText) {
				this.headerHintText.setText(this.getHeaderHintText());
			}
			return;
		}

		this.allModels = this.sortModels(models);
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRegistry.find(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		// Preserve --models order for the cycle set; append everything else sorted.
		this.cycleModelItems = this.scopedModels.map((scoped) => ({
			provider: scoped.model.provider,
			id: scoped.model.id,
			model: scoped.model,
		}));
		this.cycleKeySet = new Set(this.cycleModelItems.map(modelKey));
		const otherModels = this.allModels.filter((item) => !this.cycleKeySet.has(modelKey(item)));
		this.activeModels = [...this.cycleModelItems, ...otherModels];
		this.filteredModels = this.activeModels;
		const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex =
			currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		if (this.headerHintText) {
			this.headerHintText.setText(this.getHeaderHintText());
		}
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		const currentProvider = this.currentModel?.provider;
		// Sort: current model first, then its provider's block contiguous, then by
		// provider/id. Keeping the current model's provider block together (right
		// after the pinned current model) means a provider group header never
		// splits or duplicates when the current model belongs to a provider that
		// would otherwise sort late (e.g. "zai") — its siblings stay with it
		// instead of being pushed to the bottom of the list.
		sorted.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			if (currentProvider !== undefined) {
				const aInCurrent = a.provider === currentProvider;
				const bInCurrent = b.provider === currentProvider;
				if (aInCurrent !== bInCurrent) return aInCurrent ? -1 : 1;
			}
			if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
			return a.id.localeCompare(b.id);
		});
		return sorted;
	}

	private isCycleModel(item: ModelItem): boolean {
		return this.cycleKeySet.has(modelKey(item));
	}

	private filterModels(query: string): void {
		this.filteredModels = query
			? fuzzyFilter(this.activeModels, query, (item) => modelSearchText(item))
			: this.activeModels;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const prev = i > 0 ? this.filteredModels[i - 1] : undefined;
			const inCycle = this.isCycleModel(item);
			const prevInCycle = prev ? this.isCycleModel(prev) : false;

			// Section headers: cycle set vs the rest of the catalog.
			if (this.cycleModelItems.length > 0 && inCycle && !prevInCycle) {
				this.listContainer.addChild(new Text(theme.fg("accent", "  ● Cycle set"), 0, 0));
			}
			if (this.cycleModelItems.length > 0 && !inCycle && prevInCycle) {
				this.listContainer.addChild(new Text(theme.fg("dim", "  All models"), 0, 0));
			}

			// Provider group header: new provider or a section boundary (cycle ↔ all).
			if (!prev || prev.provider !== item.provider || inCycle !== prevInCycle) {
				this.listContainer.addChild(new Text(theme.fg("dim", `  ${item.provider}`), 0, 0));
			}

			const isSelected = i === this.selectedIndex;
			const isCurrent = modelsAreEqual(this.currentModel, item.model);
			const label = modelRowLabel(item.model);
			const checkmark = isCurrent ? theme.fg("success", " ✓") : "";

			let line = "";
			if (isSelected) {
				line = `${theme.fg("accent", "→ ")}${theme.fg("accent", label)}${checkmark}`;
			} else {
				line = `  ${theme.fg("text", label)}${checkmark}`;
			}

			this.listContainer.addChild(new TruncatedText(line, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		// Show "no results" only when there's truly nothing to list. A models.json
		// error does NOT empty the list — built-in models still load (see
		// loadModels), so we render them and surface the error as a banner below.
		if (!this.errorMessage && this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		}

		// Footer: technical id for the selection (provider header + row label stay human).
		if (this.filteredModels.length > 0) {
			const selected = this.filteredModels[this.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(theme.fg("dim", `  ${modelKey(selected)}`), 0, 0));
		}

		// Error banner (models.json failed to parse, but built-ins still loaded).
		// Shown last so it reads as a warning, not a replacement for the list.
		if (this.errorMessage) {
			this.listContainer.addChild(new Spacer(1));
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel.model);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
		// Pass everything else to search input (Tab types into search — no scope toggle)
		else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	private handleSelect(model: Model<any>): void {
		// Save as new default
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		this.onSelectCallback(model);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
