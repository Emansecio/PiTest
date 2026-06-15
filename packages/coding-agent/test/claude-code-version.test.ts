import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureClaudeCodeVersionEnv } from "../src/core/claude-code-version.js";

describe("ensureClaudeCodeVersionEnv", () => {
	const ENV = "PIT_CLAUDE_CODE_VERSION";
	let original: string | undefined;

	beforeEach(() => {
		original = process.env[ENV];
		delete process.env[ENV];
	});

	afterEach(() => {
		if (original === undefined) {
			delete process.env[ENV];
		} else {
			process.env[ENV] = original;
		}
	});

	it("sets the env var from the detector when unset", () => {
		ensureClaudeCodeVersionEnv(() => "2.1.170");
		expect(process.env[ENV]).toBe("2.1.170");
	});

	it("does not overwrite an explicit override", () => {
		process.env[ENV] = "9.9.9";
		ensureClaudeCodeVersionEnv(() => "2.1.170");
		expect(process.env[ENV]).toBe("9.9.9");
	});

	it("leaves the env unset when detection fails", () => {
		ensureClaudeCodeVersionEnv(() => undefined);
		expect(process.env[ENV]).toBeUndefined();
	});
});
