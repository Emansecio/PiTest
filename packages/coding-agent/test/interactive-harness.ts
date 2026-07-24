/**
 * Headless harness for `InteractiveMode`.
 *
 * Until the terminal became injectable, no test in this package could construct
 * the class at all (the constructor hard-wired `new ProcessTerminal()`), so the
 * whole 8k-line mode was covered only by reflection against a hand-rolled `this`.
 * This builds a REAL instance on top of `@pit/tui`'s xterm-backed
 * `VirtualTerminal`, so events can be driven end to end and the resulting frame
 * read back as text.
 *
 * Deliberately NOT calling `InteractiveMode.init()`: that path boots extensions,
 * probes `fd`/`rg`, registers process signal handlers and rebinds the session.
 * The harness mounts the same widget containers the init path mounts and marks
 * the instance initialized, which is enough to exercise `handleEvent`.
 */

import { tmpdir } from "node:os";
import { TUI } from "@pit/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent } from "../src/core/agent-session-events.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/** Settings the mode reads while constructing / handling events. */
const SETTINGS_STUB = {
	getShowHardwareCursor: () => false,
	getClearOnShrink: () => false,
	getEditorPaddingX: () => 0,
	getAutocompleteMaxVisible: () => 5,
	getFooterDensity: () => "compact",
	getHideThinkingBlock: () => false,
	getTheme: () => "dark",
	getToolActivity: () => "legacy",
	getStreamingSmoothing: () => false,
	getAssistantReadingColumns: () => 0,
	getModelRoleSettings: () => ({}),
	getWarnings: () => ({}),
	getShowTerminalProgress: () => false,
	getShowImages: () => false,
	getImageWidthCells: () => 0,
	getCardPaddingX: () => 0,
};

export interface HarnessOptions {
	columns?: number;
	rows?: number;
	/** `tui.toolActivity` — "grouped" keeps the working loader neutral. */
	toolActivity?: "grouped" | "legacy";
}

export interface InteractiveHarness {
	mode: InteractiveMode;
	terminal: VirtualTerminal;
	ui: TUI;
	/** Feed one session event through the real `handleEvent`. */
	emit(event: AgentSessionEvent): Promise<void>;
	/** Rendered text of the status band (loader / ephemeral status line). */
	statusText(): string;
	/** Rendered text of the chat transcript container. */
	chatText(): string;
	/** Whole virtual-terminal viewport after the throttled render pipeline settles. */
	screen(): Promise<string>;
	/** Current working-loader phase label, or undefined when no loader is live. */
	workingPhase(): string | undefined;
	/** True while a working loader instance exists. */
	hasWorkingLoader(): boolean;
	/** Escape hatch for asserting on private state; keep uses narrow. */
	internals(): Record<string, any>;
	dispose(): void;
}

function stripAnsi(text: string): string {
	return text.replace(/\[[0-9;]*m/g, "");
}

function renderContainer(container: any, width: number): string {
	if (!container) return "";
	const lines: string[] = container.render(width);
	return stripAnsi(lines.join("\n"));
}

/**
 * Build a real `InteractiveMode` wired to a virtual terminal.
 *
 * The session/runtime is a structural stub: enough surface for the constructor
 * and the event paths under test, and NOT a real `AgentSession` (booting one
 * spawns processes and is the job of the agent-session suites).
 */
export function createInteractiveHarness(options: HarnessOptions = {}): InteractiveHarness {
	// The theme is a process-global; pin it before constructing so colours are
	// deterministic and no watcher is installed.
	initTheme("dark");

	const columns = options.columns ?? 100;
	const rows = options.rows ?? 30;
	const terminal = new VirtualTerminal(columns, rows);
	const ui = new TUI(terminal, false);

	const settingsManager = {
		...SETTINGS_STUB,
		getToolActivity: () => options.toolActivity ?? "legacy",
	};

	// tmpdir() is deliberately outside any git repo: FooterDataProvider's
	// constructor only installs fs watchers / git polling when it finds a .git,
	// so a non-repo cwd keeps the harness free of stray handles.
	const cwd = tmpdir();

	const session: any = {
		settingsManager,
		sessionManager: {
			getCwd: () => cwd,
			getSessionName: () => undefined,
		},
		resourceLoader: { getThemes: () => ({ themes: [] }) },
		state: { messages: [] },
		autoCompactionEnabled: false,
		orchestration: undefined,
		thinkingLevel: "off",
		scopedModels: [],
		getToolDefinition: () => undefined,
		abortCompaction: () => {},
		abortRetry: () => {},
		getRecoveryLevel: () => "lean",
	};

	const runtimeHost: any = {
		session,
		services: {},
		setBeforeSessionInvalidate: () => {},
		setRebindSession: () => {},
	};

	const mode = new InteractiveMode(runtimeHost, {
		ui,
		// Keep every process-global side effect of the constructor off: the theme
		// is pinned above, and the ambient keybindings belong to whoever installed
		// them (several harnesses may live in one worker).
		installGlobalKeybindings: false,
		initializeTheme: false,
		themeWatcher: false,
	});

	const internals = mode as unknown as Record<string, any>;

	// Mount the same containers `init()` mounts, minus the extension/session boot.
	ui.addChild(internals.headerContainer);
	ui.addChild(internals.chatVisibilityContainer);
	ui.addChild(internals.pendingMessagesContainer);
	ui.addChild(internals.statusContainer);
	internals.isInitialized = true;
	ui.start();

	return {
		mode,
		terminal,
		ui,
		emit: (event) => internals.handleEvent(event),
		statusText: () => renderContainer(internals.statusContainer, columns),
		chatText: () => renderContainer(internals.chatVisibilityContainer, columns),
		screen: async () => {
			await terminal.waitForRender();
			return terminal.getViewport().join("\n");
		},
		workingPhase: () => internals.workingMessage,
		hasWorkingLoader: () => !!internals.loadingAnimation,
		internals: () => internals,
		dispose: () => {
			// stop() is the production teardown: it clears every timer the mode owns
			// (loader, countdown, goal spinner, ticker) and disposes the footer data
			// provider. `isInitialized` is reset so `ui.stop()` runs exactly once.
			mode.stop();
		},
	};
}
