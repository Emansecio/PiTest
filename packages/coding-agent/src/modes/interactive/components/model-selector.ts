import { type Model, modelsAreEqual } from "@pit/ai";
import { Container, type Focusable, fuzzyFilter, getKeybindings, Input, Spacer, Text, type TUI } from "@pit/tui";
import type { ModelRegistry } from "../../../core/model-registry.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { keyHint, selectionCursor, themedScrollPositionHint } from "./keybinding-hints.ts";
import { SelectableRow } from "./selectable-row.ts";
import { SelectorCard } from "./selector-card.ts";

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
 * OpenCode exposes two endpoints — Zen (`opencode`, https://opencode.ai/zen/v1)
 * and Go (`opencode-go`, https://opencode.ai/zen/go/v1) — that share one API key
 * (OPENCODE_API_KEY), so both surface together and their overlapping model ids
 * (deepseek-v4-flash, glm-5.2, …) would each appear twice in the picker. Collapse
 * the pair: for any id present on both, keep the Zen entry and drop the Go
 * duplicate. Zen is preferred as the primary/larger catalog; Go's unique models
 * (minimax-m3, mimo-v2-pro, qwen3.7-max, …) are untouched. A Go model is only
 * dropped when the same id is actually present under Zen in `models`, so a Go-only
 * auth setup (no Zen entries) still shows every Go model. This is a display-only
 * collapse — the registry still resolves `opencode-go/<id>` via find(), so saved
 * defaults and explicit `--models` refs keep working.
 */
export function dedupeOpencodeEndpoints(models: ModelItem[]): ModelItem[] {
	const zenIds = new Set<string>();
	for (const item of models) {
		if (item.provider === "opencode") zenIds.add(item.id);
	}
	if (zenIds.size === 0) return models;
	return models.filter((item) => !(item.provider === "opencode-go" && zenIds.has(item.id)));
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

/**
 * Compact token count for the detail line: 200000 → "200k", 1000000 → "1M".
 * A trailing `.0` is noise, so fractional steps only render a non-zero digit.
 * (footer.ts has an equivalent private helper; kept local since it isn't exported.)
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Price with sensible precision: 3 → "3", 0.25 → "0.25", 1.5 → "1.5". */
function formatPrice(value: number): string {
	return String(Math.round(value * 100) / 100);
}

/**
 * One-line, plain (untinted) detail summary for the highlighted model:
 * `provider/id · <ctx> ctx · ✦ reasoning · $<in>/$<out> per MTok`.
 * Any segment whose data is missing/zero is omitted rather than printed as
 * "undefined/0". Exported for direct unit testing.
 */
export function formatModelDetailLine(model: Model<any>): string {
	const segments: string[] = [`${model.provider}/${model.id}`];
	const ctx = model.contextWindow ?? 0;
	if (ctx > 0) segments.push(`${formatTokens(ctx)} ctx`);
	if (model.reasoning) segments.push("✦ reasoning");
	const input = model.cost?.input ?? 0;
	const output = model.cost?.output ?? 0;
	if (input > 0 || output > 0) segments.push(`$${formatPrice(input)}/$${formatPrice(output)} per MTok`);
	return segments.join(" · ");
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

		const card = new SelectorCard();
		card.addChild(new Spacer(1));

		this.headerHintText = new Text(this.getHeaderHintText(), 0, 0);
		card.addChild(this.headerHintText);
		card.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input({
			placeholder: "Type to filter models…",
			placeholderColor: (t) => theme.fg("dim", t),
		});
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			// Enter on search input selects the first filtered item
			if (this.filteredModels[this.selectedIndex]) {
				this.handleSelect(this.filteredModels[this.selectedIndex].model);
			}
		};
		card.addChild(this.searchInput);

		card.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		card.addChild(this.listContainer);

		card.addChild(new Spacer(1));
		// Uniform breathing room above the card (matches session/tree/config).
		this.addChild(new Spacer(1));
		this.addChild(card);

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
			models = dedupeOpencodeEndpoints(
				availableModels.map((model: Model<any>) => ({
					provider: model.provider,
					id: model.id,
					model,
				})),
			);
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
		const authedScoped = this.modelRegistry.filterScopedModels(this.scopedModels);
		this.cycleModelItems = authedScoped.map((scoped) => ({
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

	/**
	 * Visible-window size for the list. Adapts to terminal height the same way
	 * SelectorShell does — `clamp(rows - 12, 5, 15)` leaves room for card chrome,
	 * header, search box and the detail/scroll lines — and falls back to 10 when
	 * no terminal height is available. Recomputed per updateList so resizes stick.
	 */
	private computeMaxVisible(): number {
		const rows = this.tui.terminal?.rows;
		if (typeof rows === "number" && rows > 0) return clamp(rows - 12, 5, 15);
		return 10;
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = this.computeMaxVisible();
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
			// Use the human display name ("OpenCode Zen", "OpenCode Go") rather than the
			// raw id — otherwise two endpoints that share models read as cryptic
			// `opencode` / `opencode-go` headers over identical rows.
			if (!prev || prev.provider !== item.provider || inCycle !== prevInCycle) {
				const providerLabel = this.modelRegistry.getProviderDisplayName(item.provider);
				this.listContainer.addChild(new Text(theme.fg("dim", `  ${providerLabel}`), 0, 0));
			}

			const isSelected = i === this.selectedIndex;
			const isCurrent = modelsAreEqual(this.currentModel, item.model);
			const label = modelRowLabel(item.model);
			const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
			const cursor = selectionCursor(isSelected);
			const name = isSelected ? theme.fg("accent", label) : theme.fg("text", label);
			this.listContainer.addChild(new SelectableRow(`${cursor}${name}${checkmark}`, isSelected));
		}

		const scrollHint = themedScrollPositionHint(this.selectedIndex, this.filteredModels.length, startIndex, endIndex);
		if (scrollHint) {
			this.listContainer.addChild(new Text(scrollHint, 0, 0));
		}

		// Show "no results" only when there's truly nothing to list. A models.json
		// error does NOT empty the list — built-in models still load (see
		// loadModels), so we render them and surface the error as a banner below.
		if (!this.errorMessage && this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		}

		// Footer: one dim detail line for the selection — provider/id plus context
		// window, reasoning capability and per-MTok pricing where those exist
		// (provider header + row label stay human). Added as a Text child, which
		// wraps rather than overflows, so it stays width-safe.
		if (this.filteredModels.length > 0) {
			const selected = this.filteredModels[this.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(theme.fg("dim", `  ${formatModelDetailLine(selected.model)}`), 0, 0));
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
		// Page up - jump one window toward the top, clamped (no wrap).
		else if (kb.matches(keyData, "tui.select.pageUp")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - this.computeMaxVisible());
			this.updateList();
		}
		// Page down - jump one window toward the bottom, clamped (no wrap).
		else if (kb.matches(keyData, "tui.select.pageDown")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = Math.min(this.filteredModels.length - 1, this.selectedIndex + this.computeMaxVisible());
			this.updateList();
		}
		// Home - jump to the first filtered item.
		else if (kb.matches(keyData, "tui.select.home")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = 0;
			this.updateList();
		}
		// End - jump to the last filtered item.
		else if (kb.matches(keyData, "tui.select.end")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.filteredModels.length - 1;
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel.model);
			}
		}
		// Escape or Ctrl+C. Two-step when searching: a non-empty search is cleared
		// first (re-filter + re-render), and only a second Esc (empty search) closes.
		// Mirrors SelectorShell so every selector behaves uniformly.
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.searchInput.getValue().length > 0) {
				this.searchInput.setValue("");
				this.filterModels("");
				this.tui.requestRender();
				return;
			}
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

	/** Currently highlighted model, or undefined when the filtered list is empty. */
	getSelectedModel(): Model<any> | undefined {
		return this.filteredModels[this.selectedIndex]?.model;
	}
}
