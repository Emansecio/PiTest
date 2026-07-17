import { describe, expect, test, vi } from "vitest";
import {
	BUILTIN_SLASH_COMMANDS,
	buildGroupedSlashHelp,
	SLASH_COMMAND_GROUP_ORDER,
} from "../src/core/slash-commands.js";
import {
	DISPATCHED_SLASH_COMMAND_NAMES,
	dispatchSlashCommand,
	type SlashCommandHost,
} from "../src/modes/interactive/interactive-slash-commands.js";

/** Build a host whose every method is a spy, overriding the named ones. */
function spyHost(overrides: Partial<Record<keyof SlashCommandHost, ReturnType<typeof vi.fn>>>): SlashCommandHost {
	return new Proxy({} as SlashCommandHost, {
		get: (_target, property) => overrides[property as keyof SlashCommandHost] ?? vi.fn(),
	});
}

describe("slash command registry", () => {
	const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name));

	test.each([...DISPATCHED_SLASH_COMMAND_NAMES])(
		"dispatched command /%s is registered in BUILTIN_SLASH_COMMANDS",
		(name) => {
			expect(builtinNames.has(name)).toBe(true);
		},
	);

	test("previously-orphan commands are now registered", () => {
		for (const name of ["hindsight", "diagnostics", "debug"]) {
			expect(builtinNames.has(name)).toBe(true);
		}
	});

	test("no duplicate command names in BUILTIN_SLASH_COMMANDS", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((c) => c.name);
		expect(names.length).toBe(new Set(names).size);
	});

	test("dispatches /steer with its trimmed message", async () => {
		const clearEditor = vi.fn();
		const handleSteerCommand = vi.fn();
		const host = spyHost({ clearEditor, handleSteerCommand });

		expect(await dispatchSlashCommand(host, "/steer   focus on tests  ")).toBe(true);
		expect(clearEditor).toHaveBeenCalledOnce();
		expect(handleSteerCommand).toHaveBeenCalledWith("focus on tests");
	});

	test("/todos and /chrome are now visible (unhidden)", () => {
		for (const name of ["todos", "chrome"]) {
			const command = BUILTIN_SLASH_COMMANDS.find((c) => c.name === name);
			expect(command).toBeDefined();
			expect(command?.hidden).toBeFalsy();
		}
	});

	test("diagnostics/cache-status/debug stay hidden", () => {
		for (const name of ["diagnostics", "cache-status", "debug"]) {
			const command = BUILTIN_SLASH_COMMANDS.find((c) => c.name === name);
			expect(command?.hidden).toBe(true);
		}
	});

	test("new commands /tree /fork /config /theme are registered", () => {
		for (const name of ["tree", "fork", "config", "theme"]) {
			expect(builtinNames.has(name)).toBe(true);
		}
	});

	test("every command's group is one of SLASH_COMMAND_GROUP_ORDER", () => {
		const validGroups = new Set<string>(SLASH_COMMAND_GROUP_ORDER);
		for (const command of BUILTIN_SLASH_COMMANDS) {
			if (command.group !== undefined) {
				expect(validGroups.has(command.group)).toBe(true);
			}
		}
	});

	test("argument hints are provided for the flagged commands", () => {
		const withHints = ["goal", "compact", "name", "steer", "model", "chrome"];
		for (const name of withHints) {
			const command = BUILTIN_SLASH_COMMANDS.find((c) => c.name === name);
			expect(command?.argumentHint, `expected /${name} to have an argumentHint`).toBeTruthy();
		}
	});

	test("/model description mentions roles", () => {
		const model = BUILTIN_SLASH_COMMANDS.find((c) => c.name === "model");
		expect(model?.description.toLowerCase()).toContain("role");
	});
});

describe("new command dispatch", () => {
	test.each([
		["/tree", "showTreeSelector"],
		["/fork", "showUserMessageSelector"],
		["/config", "showConfigSelector"],
		["/theme", "showThemeSelector"],
	] as const)("%s calls host.%s and clears the editor", async (text, method) => {
		const clearEditor = vi.fn();
		const handler = vi.fn();
		const host = spyHost({ clearEditor, [method]: handler });

		expect(await dispatchSlashCommand(host, text)).toBe(true);
		expect(handler).toHaveBeenCalledOnce();
		expect(clearEditor).toHaveBeenCalledOnce();
	});
});

describe("buildGroupedSlashHelp", () => {
	test("renders a bold header per non-empty group, in order, hiding hidden commands", () => {
		const help = buildGroupedSlashHelp(BUILTIN_SLASH_COMMANDS);

		// Hidden commands never appear.
		expect(help).not.toContain("/diagnostics");
		expect(help).not.toContain("/cache-status");
		expect(help).not.toContain("/debug");

		// Group headers appear in SLASH_COMMAND_GROUP_ORDER order.
		const headerIndices = SLASH_COMMAND_GROUP_ORDER.map((group) => ({
			group,
			index: help.indexOf(`**${group}**`),
		})).filter((entry) => entry.index !== -1);
		const indices = headerIndices.map((entry) => entry.index);
		expect(indices).toEqual([...indices].sort((a, b) => a - b));

		// A representative command lands under its group header.
		expect(help).toContain("**Session**");
		expect(help).toContain("| `/tree` |");
	});

	test("commands without a group fall into Advanced", () => {
		const help = buildGroupedSlashHelp([
			{ name: "orphan", description: "no group here" },
			{ name: "settings", description: "grouped", group: "Config" },
		]);
		const advancedIdx = help.indexOf("**Advanced**");
		expect(advancedIdx).toBeGreaterThan(-1);
		expect(help.indexOf("/orphan")).toBeGreaterThan(advancedIdx);
	});
});
