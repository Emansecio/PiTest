import { describe, expect, test } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.js";
import { DISPATCHED_SLASH_COMMAND_NAMES } from "../src/modes/interactive/interactive-slash-commands.js";

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
});
