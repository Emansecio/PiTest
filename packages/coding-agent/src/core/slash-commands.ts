import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

/**
 * Coarse grouping used to organize `/help` (and, later, the "/" menu). The order
 * of this union is the order groups render in.
 */
export type SlashCommandGroup = "Session" | "Model" | "Config" | "Info" | "Advanced";

/** Render order for grouped help. Keep in sync with {@link SlashCommandGroup}. */
export const SLASH_COMMAND_GROUP_ORDER: readonly SlashCommandGroup[] = [
	"Session",
	"Model",
	"Config",
	"Info",
	"Advanced",
];

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	/**
	 * Omit from the "/" autocomplete menu. The command is still dispatched when
	 * typed and still counts as a "known" command (no typo warning, still shadows
	 * same-named extension/skill commands) — it is only hidden visually.
	 */
	hidden?: boolean;
	/**
	 * Coarse bucket for `/help` grouping. Defaults to "Advanced" when omitted so a
	 * new command never silently vanishes from a grouped list.
	 */
	group?: SlashCommandGroup;
	/**
	 * Short hint describing the command's arguments, shown in the autocomplete
	 * menu next to the description (e.g. "[instructions]" or "<message>").
	 */
	argumentHint?: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu", group: "Config" },
	{
		name: "model",
		description: "Select model, or switch role (default/smol/slow/plan/compact/commit)",
		group: "Model",
		argumentHint: "<model> | <role>",
	},
	{ name: "fusion", description: "Configure the Fusion panel (pick two models)", group: "Model" },
	{ name: "theme", description: "Pick a color theme (live preview, Esc reverts)", group: "Config" },
	{ name: "name", description: "Set session display name", group: "Session", argumentHint: "<display name>" },
	{ name: "session", description: "Show session info and stats", group: "Info" },
	{ name: "tree", description: "Browse and jump around the session tree", group: "Session" },
	{ name: "fork", description: "Fork a new session from an earlier message", group: "Session" },
	{
		name: "cache-status",
		description: "Show prompt-cache hit-rate per turn and prefix-stability diagnosis",
		group: "Advanced",
		hidden: true,
	},
	{ name: "help", description: "List available slash commands", group: "Info" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts", group: "Info" },
	{ name: "diagnostics", description: "Show runtime diagnostics", group: "Advanced", hidden: true },
	{
		name: "hindsight",
		description: "Manage hindsight bank: list | <subcommand>",
		group: "Advanced",
		hidden: true,
	},
	{ name: "debug", description: "Dump current render state to the debug log", group: "Advanced", hidden: true },
	{ name: "login", description: "Configure provider authentication", group: "Config" },
	{ name: "logout", description: "Remove provider authentication", group: "Config" },
	{ name: "new", description: "Start a new session", group: "Session" },
	{
		name: "compact",
		description: "Manually compact the session context",
		group: "Session",
		argumentHint: "[instructions]",
	},
	{
		name: "steer",
		description: "Steer the active turn without interrupting it",
		group: "Session",
		argumentHint: "<message>",
	},
	{ name: "resume", description: "Resume a different session", group: "Session" },
	{
		name: "reload",
		description: "Reload keybindings, extensions, skills, prompts, and themes",
		group: "Config",
	},
	{
		name: "config",
		description: "Enable/disable extensions, skills, prompts, and themes",
		group: "Config",
	},
	{
		name: "skills",
		description: "Skills catalog: doctor, doctor fix (opt-out dup trees), doctor verbose",
		group: "Config",
	},
	{
		name: "ttsr",
		description: "Manage TTSR rules: list | enable <name> | disable <name>",
		group: "Advanced",
		hidden: true,
	},
	{
		name: "goal",
		description:
			"Autonomous goal: open the panel, or status, <obj> to start, edit <obj>, pause, resume, clear, --tokens <budget> <obj>",
		group: "Session",
		argumentHint: "status | edit <obj> | pause | resume | clear | --tokens <budget> <obj>",
	},
	{ name: "todos", description: "Show the current todo list", group: "Session" },
	{
		name: "rewind",
		description: "Roll back files to an earlier turn (restores every file that turn touched)",
		group: "Session",
	},
	{
		name: "chrome",
		description: "Start/connect Chrome; add text before or after to run it in the browser",
		group: "Advanced",
		argumentHint: "[text to run in the browser]",
	},
	{ name: "quit", description: `Quit ${APP_NAME}`, group: "Session" },
];

/**
 * Render visible builtin slash commands as grouped markdown tables — one table
 * per group in {@link SLASH_COMMAND_GROUP_ORDER}, each with a bold header.
 * Hidden commands are dropped; commands without a group fall into "Advanced" so
 * nothing silently vanishes. Pure (no UI deps) so it is unit-testable.
 */
export function buildGroupedSlashHelp(commands: ReadonlyArray<BuiltinSlashCommand>): string {
	const visible = commands.filter((command) => !command.hidden);
	const byGroup = new Map<SlashCommandGroup, BuiltinSlashCommand[]>();
	for (const command of visible) {
		const group = command.group ?? "Advanced";
		const bucket = byGroup.get(group);
		if (bucket) {
			bucket.push(command);
		} else {
			byGroup.set(group, [command]);
		}
	}
	const sections: string[] = [];
	for (const group of SLASH_COMMAND_GROUP_ORDER) {
		const groupCommands = byGroup.get(group);
		if (!groupCommands || groupCommands.length === 0) continue;
		const rows = groupCommands.map((command) => `| \`/${command.name}\` | ${command.description} |`).join("\n");
		sections.push(`**${group}**\n| Command | Description |\n|---------|-------------|\n${rows}`);
	}
	return sections.join("\n\n");
}
