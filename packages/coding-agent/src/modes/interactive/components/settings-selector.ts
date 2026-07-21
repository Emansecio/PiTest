import type { ThinkingLevel } from "@pit/agent-core";
import type { Transport } from "@pit/ai";
import {
	Container,
	getCapabilities,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@pit/tui";
import type { WarningSettings } from "../../../core/settings-manager.ts";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme.ts";
import { HINT_SEPARATOR, keyDisplayText, keyHint } from "./keybinding-hints.ts";
import { SelectorShell } from "./selector-shell.ts";
import { beginSelectorSurface } from "./selector-surface.ts";

const SETTINGS_SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const THEME_SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
	emptyText: "No matching themes",
};

// Section headers for the grouped /settings list. Items are pushed in this order
// so each group stays contiguous (SettingsList renders a header per group).
const GROUP_APPEARANCE = "Appearance";
const GROUP_EDITOR = "Editor";
const GROUP_BEHAVIOR = "Behavior";
const GROUP_MODELS = "Models & Providers";
const GROUP_WARNINGS = "Warnings";
const GROUP_ADVANCED = "Advanced";

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning depth for the hardest problems",
	ultra: "Ultra mode — multi-agent acceleration beyond max",
};

export interface SettingsConfig {
	autoCompact: boolean;
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: Transport;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	currentTheme: string;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	doubleEscapeAction: "fork" | "tree" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	showHardwareCursor: boolean;
	editorPaddingX: number;
	autocompleteMaxVisible: number;
	quietStartup: boolean;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	warnings: WarningSettings;
	fusionVerify: boolean;
	fusionBrief: boolean;
	// Pure-UI settings backed by existing settings-manager setters. Optional so the
	// component compiles and renders (showing defaults) before the host wires the
	// current values; the host should populate these from the matching getters.
	cursorBlink?: boolean;
	streamingSmoothing?: boolean;
	editorClosedBottom?: boolean;
	toolActivity?: "grouped" | "legacy";
	footerDensity?: "calm" | "full";
	cardPaddingX?: number;
	assistantReadingColumns?: number;
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onImageWidthCellsChange: (width: number) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onTransportChange: (transport: Transport) => void;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (enabled: boolean) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onWarningsChange: (warnings: WarningSettings) => void;
	onFusionVerifyChange: (enabled: boolean) => void;
	onFusionBriefChange: (enabled: boolean) => void;
	// Optional handlers for the pure-UI settings above. Optional-chained at the
	// call site so the item toggles are inert (but visible) until the host wires
	// them to the matching settings-manager setters + any live refresh.
	onCursorBlinkChange?: (enabled: boolean) => void;
	onStreamingSmoothingChange?: (enabled: boolean) => void;
	onEditorClosedBottomChange?: (closed: boolean) => void;
	onToolActivityChange?: (mode: "grouped" | "legacy") => void;
	onFooterDensityChange?: (density: "calm" | "full") => void;
	onCardPaddingXChange?: (padding: number) => void;
	onAssistantReadingColumnsChange?: (columns: number) => void;
	onCancel: () => void;
}

/**
 * A submenu component for selecting from a list of options.
 */
class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: WarningSettings;

	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
		super();

		this.state = { ...warnings };

		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: "Anthropic extra usage",
				description: "Warn when Anthropic subscription auth may use paid extra usage (default: on)",
				currentValue: (this.state.anthropicExtraUsage ?? true) ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "new-version",
				label: "New version",
				description: 'Show a "new version available" banner at startup (default: off)',
				currentValue: (this.state.newVersion ?? false) ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "package-updates",
				label: "Package updates",
				description: 'Show a "package updates available" banner at startup (default: off)',
				currentValue: (this.state.packageUpdates ?? false) ? "true" : "false",
				values: ["true", "false"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage":
						this.state = { ...this.state, anthropicExtraUsage: newValue === "true" };
						onChange({ ...this.state });
						break;
					case "new-version":
						this.state = { ...this.state, newVersion: newValue === "true" };
						onChange({ ...this.state });
						break;
					case "package-updates":
						this.state = { ...this.state, packageUpdates: newValue === "true" };
						onChange({ ...this.state });
						break;
				}
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

class SelectSubmenu extends Container {
	private selectList: SelectList;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
	) {
		super();

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// Description
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// Spacer
		this.addChild(new Spacer(1));

		// Select list
		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			SETTINGS_SUBMENU_SELECT_LIST_LAYOUT,
		);

		// Pre-select current value
		const currentIndex = options.findIndex((o) => o.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.selectList.onSelectionChange = (item) => {
				onSelectionChange(item.value);
			};
		}

		this.addChild(this.selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				`  ${keyHint("tui.select.confirm", "select")}${HINT_SEPARATOR}${keyHint("tui.select.cancel", "back")}`,
				0,
				0,
			),
		);
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		const supportsImages = getCapabilities().images;
		const followUpKey = keyDisplayText("app.message.followUp");
		let currentWarnings = { ...config.warnings };

		// Items are pushed in section order so each `group` stays contiguous and the
		// SettingsList renders a single header per group. Descriptions carry the
		// default in "(default: X)" form; hardcoded to keep lines short.
		const items: SettingItem[] = [];

		// ---- Appearance ----
		items.push({
			id: "theme",
			group: GROUP_APPEARANCE,
			label: "Theme",
			description: "Color theme for the interface (default: dark)",
			currentValue: config.currentTheme,
			// Reuses the shared SelectorShell (search + shell grammar) inline so the
			// reachable theme picker gets type-to-filter, matching /theme.
			submenu: (currentValue, done) => {
				const themeItems: SelectItem[] = config.availableThemes.map((t) => ({
					value: t,
					// Green ✓ marks the theme active when the picker opened.
					label: t === currentValue ? `${t}${theme.fg("success", " ✓")}` : t,
				}));
				const list = new SelectList(themeItems, 10, getSelectListTheme(), THEME_SUBMENU_SELECT_LIST_LAYOUT);
				const currentIndex = config.availableThemes.indexOf(currentValue);
				if (currentIndex !== -1) list.setSelectedIndex(currentIndex);
				list.onSelect = (item) => {
					callbacks.onThemeChange(item.value);
					done(item.value);
				};
				list.onSelectionChange = (item) => {
					callbacks.onThemePreview?.(item.value);
				};
				return new SelectorShell(list, {
					title: "Theme",
					search: true,
					embedded: true,
					onCancel: () => {
						// Restore the original theme on cancel.
						callbacks.onThemePreview?.(currentValue);
						done();
					},
				});
			},
		});
		if (supportsImages) {
			items.push({
				id: "show-images",
				group: GROUP_APPEARANCE,
				label: "Show images",
				description: "Render images inline in terminal (default: on)",
				currentValue: config.showImages ? "true" : "false",
				values: ["true", "false"],
			});
			items.push({
				id: "image-width-cells",
				group: GROUP_APPEARANCE,
				label: "Image width",
				description: "Preferred inline image width in terminal cells (default: 60)",
				currentValue: String(config.imageWidthCells),
				values: ["60", "80", "120"],
			});
		}
		items.push({
			id: "hide-thinking",
			group: GROUP_APPEARANCE,
			label: "Hide thinking",
			description: "Hide thinking blocks in assistant responses (default: off)",
			currentValue: config.hideThinkingBlock ? "true" : "false",
			values: ["true", "false"],
		});
		items.push({
			id: "show-hardware-cursor",
			group: GROUP_APPEARANCE,
			label: "Show hardware cursor",
			description: "Show the terminal cursor while still positioning it for IME support (default: off)",
			currentValue: config.showHardwareCursor ? "true" : "false",
			values: ["true", "false"],
		});
		items.push({
			id: "cursor-blink",
			group: GROUP_APPEARANCE,
			label: "Cursor blink",
			description: "Blink the input editor's block cursor while focused (default: on)",
			currentValue: (config.cursorBlink ?? true) ? "true" : "false",
			values: ["true", "false"],
		});
		items.push({
			id: "footer-density",
			group: GROUP_APPEARANCE,
			label: "Footer density",
			description: "Footer layout: calm (minimal) or full power-user (default: calm)",
			currentValue: config.footerDensity ?? "calm",
			values: ["calm", "full"],
		});
		items.push({
			id: "card-padding",
			group: GROUP_APPEARANCE,
			label: "Card padding",
			description: "Horizontal padding inside card frames, 0-3 (default: 1)",
			currentValue: String(config.cardPaddingX ?? 1),
			values: ["0", "1", "2", "3"],
		});
		items.push({
			id: "assistant-reading-columns",
			group: GROUP_APPEARANCE,
			label: "Reading width",
			description: "Reading-column cap for assistant prose; 0 = full width (default: 120)",
			currentValue: String(config.assistantReadingColumns ?? 120),
			values: ["0", "80", "100", "120", "160", "200"],
		});

		// ---- Editor ----
		items.push({
			id: "editor-padding",
			group: GROUP_EDITOR,
			label: "Editor padding",
			description: "Horizontal padding for input editor, 0-3 (default: 1)",
			currentValue: String(config.editorPaddingX),
			values: ["0", "1", "2", "3"],
		});
		items.push({
			id: "editor-closed-bottom",
			group: GROUP_EDITOR,
			label: "Editor closed bottom",
			description: "Draw a closed frame under the input instead of a single hairline (default: off)",
			currentValue: (config.editorClosedBottom ?? false) ? "true" : "false",
			values: ["true", "false"],
		});
		items.push({
			id: "autocomplete-max-visible",
			group: GROUP_EDITOR,
			label: "Autocomplete max items",
			description: "Max visible items in autocomplete dropdown, 3-20 (default: 5)",
			currentValue: String(config.autocompleteMaxVisible),
			values: ["3", "5", "7", "10", "15", "20"],
		});
		items.push({
			id: "streaming-smoothing",
			group: GROUP_EDITOR,
			label: "Streaming smoothing",
			description: "Reveal streamed text at a steady rate instead of provider-sized bursts (default: on)",
			currentValue: (config.streamingSmoothing ?? true) ? "true" : "false",
			values: ["true", "false"],
		});

		// ---- Behavior ----
		items.push({
			id: "autocompact",
			group: GROUP_BEHAVIOR,
			label: "Auto-compact",
			description: "Automatically compact context when it gets too large (default: on)",
			currentValue: config.autoCompact ? "true" : "false",
			values: ["true", "false"],
		});
		items.push({
			id: "steering-mode",
			group: GROUP_BEHAVIOR,
			label: "Steering mode",
			description:
				"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait; 'all': deliver together (default: one-at-a-time)",
			currentValue: config.steeringMode,
			values: ["one-at-a-time", "all"],
		});
		items.push({
			id: "follow-up-mode",
			group: GROUP_BEHAVIOR,
			label: "Follow-up mode",
			description: `${followUpKey} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait; 'all': deliver together (default: one-at-a-time)`,
			currentValue: config.followUpMode,
			values: ["one-at-a-time", "all"],
		});
		items.push({
			id: "double-escape-action",
			group: GROUP_BEHAVIOR,
			label: "Double-escape action",
			description: "Action when pressing Escape twice with empty editor (default: tree)",
			currentValue: config.doubleEscapeAction,
			values: ["tree", "fork", "none"],
		});
		items.push({
			id: "tree-filter-mode",
			group: GROUP_BEHAVIOR,
			label: "Tree filter mode",
			description: "Default filter when opening /tree (default: default)",
			currentValue: config.treeFilterMode,
			values: ["default", "no-tools", "user-only", "labeled-only", "all"],
		});
		items.push({
			id: "skill-commands",
			group: GROUP_BEHAVIOR,
			label: "Skill commands",
			description: "Register skills as /name commands (default: on)",
			currentValue: config.enableSkillCommands ? "true" : "false",
			values: ["true", "false"],
		});
		items.push({
			id: "tool-activity",
			group: GROUP_BEHAVIOR,
			label: "Tool activity",
			description: "Tool call display: grouped activity cards or legacy per-call blocks (default: grouped)",
			currentValue: config.toolActivity ?? "grouped",
			values: ["grouped", "legacy"],
		});
		items.push({
			id: "clear-on-shrink",
			group: GROUP_BEHAVIOR,
			label: "Clear on shrink",
			description: "Clear empty rows when content shrinks; may cause flicker (default: off)",
			currentValue: config.clearOnShrink ? "true" : "false",
			values: ["true", "false"],
		});
		items.push({
			id: "terminal-progress",
			group: GROUP_BEHAVIOR,
			label: "Terminal progress",
			description: "Show OSC 9;4 progress indicators in the terminal tab bar (default: off)",
			currentValue: config.showTerminalProgress ? "true" : "false",
			values: ["true", "false"],
		});

		// ---- Models & Providers ----
		items.push({
			id: "transport",
			group: GROUP_MODELS,
			label: "Transport",
			description: "Preferred transport for providers that support multiple transports (default: auto)",
			currentValue: config.transport,
			values: ["sse", "websocket", "websocket-cached", "auto"],
		});
		items.push({
			id: "thinking",
			group: GROUP_MODELS,
			label: "Thinking level",
			description: "Reasoning depth for thinking-capable models",
			currentValue: config.thinkingLevel,
			submenu: (currentValue, done) =>
				new SelectSubmenu(
					"Thinking Level",
					"Select reasoning depth for thinking-capable models",
					config.availableThinkingLevels.map((level) => ({
						value: level,
						label: level,
						description: THINKING_DESCRIPTIONS[level],
					})),
					currentValue,
					(value) => {
						callbacks.onThinkingLevelChange(value as ThinkingLevel);
						done(value);
					},
					() => done(),
				),
		});

		// ---- Warnings ----
		items.push({
			id: "warnings",
			group: GROUP_WARNINGS,
			label: "Warnings",
			description: "Enable or disable individual startup warnings",
			currentValue: "configure",
			submenu: (_currentValue, done) =>
				new WarningSettingsSubmenu(
					currentWarnings,
					(warnings) => {
						currentWarnings = warnings;
						callbacks.onWarningsChange(warnings);
					},
					() => done(),
				),
		});

		// ---- Advanced ----
		items.push({
			id: "fusion-verify",
			group: GROUP_ADVANCED,
			label: "Fusion verify",
			description: "Fact-check advisor claims against the code before the writer, Fusion mode (default: on)",
			currentValue: config.fusionVerify ? "true" : "false",
			values: ["true", "false"],
		});
		items.push({
			id: "fusion-brief",
			group: GROUP_ADVANCED,
			label: "Fusion brief",
			description: "Synthesizer rewrites the prompt for advisors before the panel, Fusion mode (default: on)",
			currentValue: config.fusionBrief ? "true" : "false",
			values: ["true", "false"],
		});
		items.push({
			id: "auto-resize-images",
			group: GROUP_ADVANCED,
			label: "Auto-resize images",
			description: "Resize large images to 2000x2000 max for better model compatibility (default: on)",
			currentValue: config.autoResizeImages ? "true" : "false",
			values: ["true", "false"],
		});
		items.push({
			id: "block-images",
			group: GROUP_ADVANCED,
			label: "Block images",
			description: "Prevent images from being sent to LLM providers (default: off)",
			currentValue: config.blockImages ? "true" : "false",
			values: ["true", "false"],
		});
		items.push({
			id: "quiet-startup",
			group: GROUP_ADVANCED,
			label: "Quiet startup",
			description: "Disable verbose printing at startup (default: off)",
			currentValue: config.quietStartup ? "true" : "false",
			values: ["true", "false"],
		});

		const { surface, mount } = beginSelectorSurface(this, true);

		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "autocompact":
						callbacks.onAutoCompactChange(newValue === "true");
						break;
					case "show-images":
						callbacks.onShowImagesChange(newValue === "true");
						break;
					case "image-width-cells":
						callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
						break;
					case "auto-resize-images":
						callbacks.onAutoResizeImagesChange(newValue === "true");
						break;
					case "block-images":
						callbacks.onBlockImagesChange(newValue === "true");
						break;
					case "skill-commands":
						callbacks.onEnableSkillCommandsChange(newValue === "true");
						break;
					case "steering-mode":
						callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "follow-up-mode":
						callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "transport":
						callbacks.onTransportChange(newValue as Transport);
						break;
					case "hide-thinking":
						callbacks.onHideThinkingBlockChange(newValue === "true");
						break;
					case "quiet-startup":
						callbacks.onQuietStartupChange(newValue === "true");
						break;
					case "fusion-verify":
						callbacks.onFusionVerifyChange(newValue === "true");
						break;
					case "fusion-brief":
						callbacks.onFusionBriefChange(newValue === "true");
						break;
					case "double-escape-action":
						callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree" | "none");
						break;
					case "tree-filter-mode":
						callbacks.onTreeFilterModeChange(
							newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all",
						);
						break;
					case "show-hardware-cursor":
						callbacks.onShowHardwareCursorChange(newValue === "true");
						break;
					case "editor-padding":
						callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
						break;
					case "autocomplete-max-visible":
						callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
						break;
					case "clear-on-shrink":
						callbacks.onClearOnShrinkChange(newValue === "true");
						break;
					case "terminal-progress":
						callbacks.onShowTerminalProgressChange(newValue === "true");
						break;
					// Pure-UI settings — optional-chained so they stay inert (but
					// visible) until the host wires the matching setters.
					case "cursor-blink":
						callbacks.onCursorBlinkChange?.(newValue === "true");
						break;
					case "streaming-smoothing":
						callbacks.onStreamingSmoothingChange?.(newValue === "true");
						break;
					case "editor-closed-bottom":
						callbacks.onEditorClosedBottomChange?.(newValue === "true");
						break;
					case "tool-activity":
						callbacks.onToolActivityChange?.(newValue as "grouped" | "legacy");
						break;
					case "footer-density":
						callbacks.onFooterDensityChange?.(newValue as "calm" | "full");
						break;
					case "card-padding":
						callbacks.onCardPaddingXChange?.(parseInt(newValue, 10));
						break;
					case "assistant-reading-columns":
						callbacks.onAssistantReadingColumnsChange?.(parseInt(newValue, 10));
						break;
				}
			},
			callbacks.onCancel,
			{ enableSearch: true },
		);

		surface.addChild(this.settingsList);
		mount();
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}
