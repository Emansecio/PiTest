import { describe, expect, it } from "vitest";
import { assertProjectAwarePosition } from "../../src/core/lsp/position-policy.ts";
import type { ServerConfig } from "../../src/core/lsp/types.ts";

const PROJECT_AWARE: ServerConfig = {
	command: "typescript-language-server",
	fileTypes: [".ts"],
	rootMarkers: ["package.json"],
};

const LINTER: ServerConfig = {
	command: "biome",
	fileTypes: [".ts"],
	rootMarkers: ["biome.json"],
	isLinter: true,
};

describe("assertProjectAwarePosition", () => {
	it("requires line and symbol on project-aware servers", () => {
		expect(() => assertProjectAwarePosition("hover", { line: 1 }, PROJECT_AWARE)).toThrow(/symbol is required/);
		expect(() => assertProjectAwarePosition("hover", { symbol: "foo" }, PROJECT_AWARE)).toThrow(/line is required/);
		expect(() => assertProjectAwarePosition("hover", { line: 1, symbol: "foo" }, PROJECT_AWARE)).not.toThrow();
	});

	it("does not enforce on linters", () => {
		expect(() => assertProjectAwarePosition("hover", {}, LINTER)).not.toThrow();
	});

	it("rejects line 0 as invalid 1-based line number", () => {
		expect(() => assertProjectAwarePosition("hover", { line: 0, symbol: "foo" }, PROJECT_AWARE)).toThrow(
			/1-based line number/,
		);
	});

	it("covers implementation and code_actions", () => {
		expect(() => assertProjectAwarePosition("implementation", { line: 2 }, PROJECT_AWARE)).toThrow(/symbol/);
		expect(() => assertProjectAwarePosition("code_actions", { line: 2, symbol: "x" }, PROJECT_AWARE)).not.toThrow();
	});
});
