import { describe, expect, test, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.js";
import {
	DISPATCHED_SLASH_COMMAND_NAMES,
	dispatchSlashCommand,
	type SlashCommandHost,
} from "../src/modes/interactive/interactive-slash-commands.js";

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
		const host = new Proxy({} as SlashCommandHost, {
			get: (_target, property) => {
				if (property === "clearEditor") return clearEditor;
				if (property === "handleSteerCommand") return handleSteerCommand;
				return vi.fn();
			},
		});

		expect(await dispatchSlashCommand(host, "/steer   focus on tests  ")).toBe(true);
		expect(clearEditor).toHaveBeenCalledOnce();
		expect(handleSteerCommand).toHaveBeenCalledWith("focus on tests");
	});
});
