import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "cache-status", description: "Show prompt-cache hit-rate per turn and prefix-stability diagnosis" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "ttsr", description: "Manage TTSR rules: list | enable <name> | disable <name>" },
	{
		name: "goal",
		description: "Autonomous goal mode: <objective> | edit <obj> | pause | resume | clear | --tokens <budget> <obj>",
	},
	{ name: "todos", description: "Show the current todo list" },
	{ name: "chrome", description: "Start/connect Chrome; add text before or after to run it in the browser" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];
