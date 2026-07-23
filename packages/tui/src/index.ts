// Core TUI interfaces and classes

// Autocomplete support
export {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "./autocomplete.ts";
// Components
export { Box } from "./components/box.ts";
export { CancellableLoader } from "./components/cancellable-loader.ts";
export { Card } from "./components/card.ts";
export {
	buildCheatsheetRows,
	Cheatsheet,
	type CheatsheetRow,
	type CheatsheetTheme,
	renderCheatsheet,
} from "./components/cheatsheet.ts";
export { Editor, type EditorOptions, type EditorTheme } from "./components/editor.ts";
export { Image, type ImageOptions, type ImageTheme } from "./components/image.ts";
export { Input, type InputOptions } from "./components/input.ts";
export {
	HEARTBEAT_CYCLE_MS,
	Loader,
	type LoaderColorFn,
	type LoaderIndicatorOptions,
	SPINNER_FRAME_MS,
	SPINNER_FRAMES,
} from "./components/loader.ts";
export { type DefaultTextStyle, Markdown, type MarkdownTheme } from "./components/markdown.ts";
export {
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	type SelectListTruncatePrimaryContext,
} from "./components/select-list.ts";
export { type SettingItem, SettingsList, type SettingsListTheme } from "./components/settings-list.ts";
export { Spacer } from "./components/spacer.ts";
export { Text } from "./components/text.ts";
export { TruncatedText } from "./components/truncated-text.ts";
// Editor component interface (for custom editors)
export type { EditorComponent } from "./editor-component.ts";
// Fuzzy matching
export { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "./fuzzy.ts";
// Keybindings
export {
	getKeybindings,
	type Keybinding,
	type KeybindingConflict,
	type KeybindingDefinition,
	type KeybindingDefinitions,
	type Keybindings,
	type KeybindingsConfig,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "./keybindings.ts";
// Keyboard input handling
export {
	decodeKittyPrintable,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	Key,
	type KeyEventType,
	type KeyId,
	matchesKey,
	parseKey,
	setKittyProtocolActive,
} from "./keys.ts";
export { type RenderPetCellsOptions, renderPetCells } from "./pet-cells.ts";
// Terminal image support
export {
	coverage as petCoverageRamp,
	mixRgb,
	type PetColors,
	type PetParams,
	petCoverage,
	type Rgb,
	sdEllipse,
	sdRoundBox,
	shadePet,
} from "./pet-geometry.ts";
export {
	type EncodeSixelOptions,
	encodeSixel,
	type RenderPetSixelOptions,
	renderPetSixel,
	SIXEL_INTRO,
} from "./sixel.ts";
// Input buffering for batch splitting
export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "./stdin-buffer.ts";
// Terminal interface and implementations
export { ProcessTerminal, type Terminal } from "./terminal.ts";
export {
	allocateImageId,
	type CellDimensions,
	calculateImageRows,
	deleteAllKittyImages,
	deleteKittyImage,
	detectCapabilities,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getPngDimensions,
	getSixelSupport,
	getWebpDimensions,
	hyperlink,
	type ImageDimensions,
	type ImageProtocol,
	type ImageRenderOptions,
	imageFallback,
	isSixelForcedOff,
	isSixelSupportKnown,
	parseSixelDeviceAttributes,
	renderImage,
	resetCapabilitiesCache,
	resetSixelSupport,
	setCapabilities,
	setCellDimensions,
	setSixelSupport,
	type TerminalCapabilities,
} from "./terminal-image.ts";
export {
	type AnimationFrameCallback,
	type Component,
	Container,
	CURSOR_MARKER,
	type Focusable,
	isFocusable,
	type OverlayAnchor,
	type OverlayHandle,
	type OverlayMargin,
	type OverlayOptions,
	type SizeValue,
	TUI,
} from "./tui.ts";
// Utilities
export { getSegmenter, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./utils.ts";
export { DEFAULT_VIRTUALIZED_TAIL_LINE_BUDGET, VirtualizedContainer } from "./virtualized-container.ts";
