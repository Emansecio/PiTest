import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { resolveAppMode } from "../src/main.ts";

describe("resolveAppMode", () => {
	test("explicit --mode text selects print mode even when stdin is a TTY", () => {
		expect(resolveAppMode(parseArgs(["--mode", "text"]), true)).toBe("print");
	});
});
