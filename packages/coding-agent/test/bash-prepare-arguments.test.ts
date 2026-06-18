import { describe, expect, it } from "vitest";
import { prepareBashArguments } from "../src/core/tools/bash.ts";

/**
 * prepareBashArguments runs pre-execution (key aliases + commands-join + trim).
 * The trim aligns execution with bash-grounding/simple-argv, which already trim
 * for parsing — surrounding whitespace otherwise reaches the shell literally.
 */
describe("prepareBashArguments — command trim", () => {
	it("trims leading/trailing whitespace from the command", () => {
		expect(prepareBashArguments({ command: "  npm run build  " })).toEqual({ command: "npm run build" });
	});

	it("keeps the same reference when nothing changes (clean command)", () => {
		const input = { command: "npm run build" };
		expect(prepareBashArguments(input)).toBe(input);
	});

	it("trims after aliasing and joining commands", () => {
		expect(prepareBashArguments({ cmd: "  ls  " })).toEqual({ command: "ls" });
		expect(prepareBashArguments({ commands: ["  a ", " b  "] })).toEqual({ command: "a  &&  b" });
	});

	it("does not disturb internal whitespace", () => {
		expect(prepareBashArguments({ command: 'echo "a  b"' })).toEqual({ command: 'echo "a  b"' });
	});
});
