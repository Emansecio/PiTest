import { describe, expect, test } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.js";

/**
 * Guard against orphan slash commands: any command that InteractiveMode dispatches
 * (via `_exactSlashCommands` or the prefix-matched literals in `_dispatchSlashCommand`)
 * MUST also appear in BUILTIN_SLASH_COMMANDS, otherwise it is invisible in autocomplete
 * and absent from `_knownCommandNames` (so a typo of it gets no suggestion).
 *
 * The dispatch tables live as private statics / inline literals inside
 * interactive-mode.ts and cannot be imported without a refactor, so this list is
 * mirrored by hand. Easter eggs (/arminsayshi, /dementedelves) are intentionally
 * excluded — they are hidden surprises, not discoverable commands.
 *
 * If you add a new dispatched command, add it here (and to BUILTIN_SLASH_COMMANDS).
 */
const DISPATCHED_COMMANDS = [
	// _dispatchSlashCommand prefix-matched literals
	"model",
	"fusion",
	"name",
	"compact",
	"ttsr",
	"hindsight",
	"goal",
	"todos",
	// _exactSlashCommands map keys
	"settings",
	"session",
	"cache-status",
	"diagnostics",
	"changelog",
	"help",
	"hotkeys",
	"login",
	"logout",
	"new",
	"reload",
	"debug",
	"resume",
	"quit",
];

describe("slash command registry", () => {
	const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name));

	test.each(DISPATCHED_COMMANDS)("dispatched command /%s is registered in BUILTIN_SLASH_COMMANDS", (name) => {
		expect(builtinNames.has(name)).toBe(true);
	});

	test("previously-orphan commands are now registered", () => {
		for (const name of ["hindsight", "diagnostics", "changelog", "debug"]) {
			expect(builtinNames.has(name)).toBe(true);
		}
	});

	test("no duplicate command names in BUILTIN_SLASH_COMMANDS", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((c) => c.name);
		expect(names.length).toBe(new Set(names).size);
	});
});
