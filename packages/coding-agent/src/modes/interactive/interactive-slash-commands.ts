/**
 * Slash-command dispatch extracted from InteractiveMode (move-only).
 */

export interface SlashCommandHost {
	clearEditor(): void;
	handleModelCommand(searchTerm?: string): void | Promise<void>;
	handleFusionCommand(): void | Promise<void>;
	handleNameCommand(text: string): void;
	handleCompactCommand(instructions?: string): void | Promise<void>;
	handleSteerCommand(text: string): void | Promise<void>;
	handleTTSRCommand(args: string): void;
	handleHindsightCommand(args: string): void | Promise<void>;
	handleGoalCommand(args: string): void | Promise<void>;
	showStatus(text: string): void;
	getTodoSummaryText(): string;
	showSettingsSelector(): void | Promise<void>;
	showThemeSelector(): void | Promise<void>;
	showConfigSelector(): void | Promise<void>;
	showTreeSelector(): void | Promise<void>;
	showUserMessageSelector(): void | Promise<void>;
	handleSessionCommand(): void | Promise<void>;
	handleCacheStatusCommand(): void | Promise<void>;
	handleDiagnosticsCommand(): void | Promise<void>;
	handleHelpCommand(): void | Promise<void>;
	handleHotkeysCommand(): void | Promise<void>;
	showOAuthSelector(mode: "login" | "logout"): void | Promise<void>;
	handleClearCommand(): void | Promise<void>;
	handleReloadCommand(): void | Promise<void>;
	handleSkillsCommand(args: string): void | Promise<void>;
	handleDebugCommand(): void | Promise<void>;
	handleArminSaysHi(): void | Promise<void>;
	handleDementedDelves(): void | Promise<void>;
	showSessionSelector(): void | Promise<void>;
	shutdown(): void | Promise<void>;
	isSessionBusy(): boolean;
	isExtensionCommand(text: string): boolean;
	addEditorHistory(text: string): void;
	promptExtensionCommand(text: string): void | Promise<void>;
}

/** Commands dispatched by prefix or exact match (excludes hidden easter eggs). */
export const DISPATCHED_SLASH_COMMAND_NAMES = [
	"model",
	"fusion",
	"name",
	"compact",
	"steer",
	"ttsr",
	"hindsight",
	"goal",
	"todos",
	"settings",
	"theme",
	"config",
	"tree",
	"fork",
	"session",
	"cache-status",
	"diagnostics",
	"help",
	"hotkeys",
	"login",
	"logout",
	"new",
	"reload",
	"skills",
	"debug",
	"resume",
	"quit",
] as const;

export const exactSlashCommands = new Map<string, (host: SlashCommandHost) => void | Promise<void>>([
	["/settings", (host) => host.showSettingsSelector()],
	["/theme", (host) => host.showThemeSelector()],
	["/config", (host) => host.showConfigSelector()],
	["/tree", (host) => host.showTreeSelector()],
	["/fork", (host) => host.showUserMessageSelector()],
	["/session", (host) => host.handleSessionCommand()],
	["/cache-status", (host) => host.handleCacheStatusCommand()],
	["/diagnostics", (host) => host.handleDiagnosticsCommand()],
	["/help", (host) => host.handleHelpCommand()],
	["/hotkeys", (host) => host.handleHotkeysCommand()],
	["/login", (host) => host.showOAuthSelector("login")],
	["/logout", (host) => host.showOAuthSelector("logout")],
	["/new", (host) => host.handleClearCommand()],
	["/reload", (host) => host.handleReloadCommand()],
	["/debug", (host) => host.handleDebugCommand()],
	["/arminsayshi", (host) => host.handleArminSaysHi()],
	["/dementedelves", (host) => host.handleDementedDelves()],
	["/resume", (host) => host.showSessionSelector()],
	["/quit", (host) => host.shutdown()],
]);

export function stripSlashArg(text: string, command: string): string {
	return text.slice(command.length).trim();
}

export async function dispatchSlashCommand(host: SlashCommandHost, text: string): Promise<boolean> {
	if (text === "/model" || text.startsWith("/model ")) {
		host.clearEditor();
		await host.handleModelCommand(text.startsWith("/model ") ? stripSlashArg(text, "/model") : undefined);
		return true;
	}
	if (text === "/fusion") {
		host.clearEditor();
		await host.handleFusionCommand();
		return true;
	}
	if (text === "/name" || text.startsWith("/name ")) {
		host.handleNameCommand(text);
		host.clearEditor();
		return true;
	}
	if (text === "/compact" || text.startsWith("/compact ")) {
		host.clearEditor();
		await host.handleCompactCommand(text.startsWith("/compact ") ? stripSlashArg(text, "/compact") : undefined);
		return true;
	}
	if (text === "/steer" || text.startsWith("/steer ")) {
		host.clearEditor();
		await host.handleSteerCommand(text === "/steer" ? "" : stripSlashArg(text, "/steer"));
		return true;
	}
	if (text === "/ttsr" || text.startsWith("/ttsr ")) {
		host.clearEditor();
		host.handleTTSRCommand(text === "/ttsr" ? "" : stripSlashArg(text, "/ttsr"));
		return true;
	}
	if (text === "/hindsight" || text.startsWith("/hindsight ")) {
		host.clearEditor();
		await host.handleHindsightCommand(text === "/hindsight" ? "" : stripSlashArg(text, "/hindsight"));
		return true;
	}
	if (text === "/goal" || text.startsWith("/goal ")) {
		host.clearEditor();
		await host.handleGoalCommand(text === "/goal" ? "" : stripSlashArg(text, "/goal"));
		return true;
	}
	if (text === "/todos") {
		host.clearEditor();
		host.showStatus(host.getTodoSummaryText());
		return true;
	}
	if (text === "/skills" || text.startsWith("/skills ")) {
		host.clearEditor();
		await host.handleSkillsCommand(text === "/skills" ? "" : stripSlashArg(text, "/skills"));
		return true;
	}

	const cmd = exactSlashCommands.get(text);
	if (cmd) {
		host.clearEditor();
		await cmd(host);
		return true;
	}

	if (!host.isSessionBusy() && host.isExtensionCommand(text)) {
		host.addEditorHistory(text);
		host.clearEditor();
		await host.promptExtensionCommand(text);
		return true;
	}

	return false;
}
