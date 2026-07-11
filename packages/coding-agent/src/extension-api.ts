/**
 * Slim public surface for extensions loaded via jiti on Node.
 *
 * Intentionally avoids importing `agent-session.ts` and `./core/tools/index.ts`
 * (full tools registry / optional chrome·lsp·debug stacks). Bun compile still
 * virtualizes the full package index — see `core/extensions/loader.ts`.
 */

export { getAgentDir, VERSION } from "./config.ts";
export { serializeConversation } from "./core/compaction/utils.ts";
export { createEventBus, type EventBus, type EventBusController } from "./core/event-bus.ts";
// Extension types + runtime helpers (type-only tool imports are erased)
export type {
	AgentEndEvent,
	AgentStartEvent,
	AgentToolResult,
	AgentToolUpdateCallback,
	AppKeybinding,
	AutocompleteProviderFactory,
	BashToolCallEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	BuildSystemPromptOptions,
	CompactOptions,
	ContextEvent,
	ContextUsage,
	CustomToolCallEvent,
	EditToolCallEvent,
	ExecOptions,
	ExecResult,
	Extension,
	ExtensionActions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionHandler,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	FindToolCallEvent,
	GrepToolCallEvent,
	InputEvent,
	InputEventResult,
	InputSource,
	KeybindingsManager,
	LoadExtensionsResult,
	LsToolCallEvent,
	MessageRenderer,
	MessageRenderOptions,
	ProviderConfig,
	ProviderModelConfig,
	ReadToolCallEvent,
	RegisteredCommand,
	RegisteredTool,
	ResolvedCommand,
	SessionBeforeCompactEvent,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionBeforeTreeEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionTreeEvent,
	TerminalInputHandler,
	ToolCallEvent,
	ToolCallEventResult,
	ToolDefinition,
	ToolExecutionMode,
	ToolInfo,
	ToolRenderResultOptions,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
	UserBashEvent,
	UserBashEventResult,
	WidgetPlacement,
	WorkingIndicatorOptions,
	WriteToolCallEvent,
} from "./core/extensions/types.ts";
export {
	defineTool,
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
} from "./core/extensions/types.ts";
export type { ReadonlyFooterDataProvider } from "./core/footer-data-provider.ts";
export { convertToLlm } from "./core/messages.ts";
export type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	FileEntry,
	ModelChangeEntry,
	NewSessionOptions,
	SessionContext,
	SessionEntry,
	SessionEntryBase,
	SessionHeader,
	SessionInfo,
	SessionInfoEntry,
	SessionMessageEntry,
	ThinkingLevelChangeEntry,
} from "./core/session-manager.ts";
export { SessionManager } from "./core/session-manager.ts";
export type {
	CompactionSettings,
	ImageSettings,
	PackageSource,
	RetrySettings,
} from "./core/settings-manager.ts";
export { SettingsManager } from "./core/settings-manager.ts";
export type { SlashCommandInfo, SlashCommandSource } from "./core/slash-commands.ts";
export type { SourceInfo } from "./core/source-info.ts";
export { createSyntheticSourceInfo } from "./core/source-info.ts";

// Individual tool modules — not the full tools registry
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createLocalBashOperations,
} from "./core/tools/bash.ts";
export {
	createEditTool,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./core/tools/edit.ts";
export { withFileMutationQueue } from "./core/tools/file-mutation-queue.ts";
export {
	createFindTool,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./core/tools/find.ts";
export {
	createGrepTool,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./core/tools/grep.ts";
export {
	createLsTool,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./core/tools/ls.ts";
export {
	createReadTool,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./core/tools/read.ts";
export {
	createWriteTool,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./core/tools/write.ts";
export { BorderedLoader } from "./modes/interactive/components/bordered-loader.ts";
export { CustomEditor } from "./modes/interactive/components/custom-editor.ts";
export { DynamicBorder } from "./modes/interactive/components/dynamic-border.ts";
export { keyHint, keyText, rawKeyHint } from "./modes/interactive/components/keybinding-hints.ts";
// Theme + common extension UI (avoid components/index — pulls tool-execution → tools/index)
export {
	getLanguageFromPath,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	highlightCode,
	initTheme,
	Theme,
	type ThemeColor,
} from "./modes/interactive/theme/theme.ts";

export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.ts";
export { getShellConfig } from "./utils/shell.ts";
