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
 * Coarse grouping used to organize `/help` and the "/" menu. The order of this
 * union is the order groups render in.
 */
export type SlashCommandGroup = "Session" | "Model" | "Config" | "Info" | "Advanced" | "Project";

/** Render order for grouped help. Keep in sync with {@link SlashCommandGroup}. */
export const SLASH_COMMAND_GROUP_ORDER: readonly SlashCommandGroup[] = [
	"Session",
	"Model",
	"Config",
	"Info",
	"Advanced",
	"Project",
];

/** Minimal shape consumed by the grouped help renderer. Keeping this separate
 * from the TUI command type lets the runtime registry include extensions,
 * prompts, and skills without coupling this core module to the TUI package. */
export interface SlashCommandHelpEntry {
	name: string;
	description?: string;
	group?: SlashCommandGroup | string;
	hidden?: boolean;
	badge?: string;
}

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
	/**
	 * The bare command (no argument) is not a valid invocation — dispatching it
	 * only produces a usage warning. Enter on the autocomplete suggestion then
	 * completes like Tab instead of submitting an empty call. Argument validity
	 * is dispatch logic, so this is declared explicitly, never inferred from
	 * argumentHint (e.g. `/model` has a hint but a valid bare form).
	 */
	completeOnly?: boolean;
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
	{
		name: "mouse",
		description: "Toggle mouse: click positions · drag selects+copies · right-click copies · Shift+drag native",
		group: "Config",
	},
	{
		name: "name",
		description: "Set session display name",
		group: "Session",
		argumentHint: "<display name>",
		completeOnly: true,
	},
	{ name: "session", description: "Show session info and stats", group: "Info" },
	{ name: "jobs", description: "Background tasks: view output, kill (also alt+j)", group: "Info" },
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
		completeOnly: true,
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
		name: "pin",
		description: "Pin a critical fact or file so it survives compaction — no args lists current pins",
		group: "Session",
		argumentHint: "[text or path]",
	},
	{ name: "unpin", description: "Remove a pin by id", group: "Session", argumentHint: "<id>", completeOnly: true },
	{
		name: "plan",
		description: "Enter plan mode (read-only): research and build a plan, then exit_plan to execute",
		group: "Session",
	},
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
 * Render effective slash commands as grouped markdown tables — one table
 * per group in {@link SLASH_COMMAND_GROUP_ORDER}, each with a bold header.
 * Hidden commands are dropped; commands without a group fall into "Advanced" so
 * nothing silently vanishes. Pure (no UI deps) so it is unit-testable.
 */
export function buildGroupedSlashHelp(commands: ReadonlyArray<SlashCommandHelpEntry>): string {
	const escapeTableCell = (value: string): string =>
		value
			.replace(/\\/g, "\\\\")
			.replace(/[\r\n]+/g, " ")
			.replace(/\|/g, "\\|");
	const visible = commands.filter((command) => !command.hidden);
	const byGroup = new Map<SlashCommandGroup, SlashCommandHelpEntry[]>();
	for (const command of visible) {
		const group = SLASH_COMMAND_GROUP_ORDER.includes(command.group as SlashCommandGroup)
			? (command.group as SlashCommandGroup)
			: "Advanced";
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
		const rows = groupCommands
			.map((command) => {
				const commandLabel = command.badge ? `/${command.name} [${command.badge}]` : `/${command.name}`;
				return `| \`${escapeTableCell(commandLabel)}\` | ${escapeTableCell(command.description ?? "")} |`;
			})
			.join("\n");
		sections.push(`**${group}**\n| Command | Description |\n|---------|-------------|\n${rows}`);
	}
	return sections.join("\n\n");
}
