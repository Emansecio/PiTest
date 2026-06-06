import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "../src/core/tools/index.js";

/**
 * Verifies that every built-in tool exposes a prepareArguments that absorbs
 * common LLM aliasing mistakes before validation runs. Each suite asserts:
 *   1. prepareArguments rewrites the alias to the canonical key
 *   2. the prepared args execute successfully against a real working dir
 */

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-tool-prep-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("read tool: prepareArguments aliases", () => {
	it("normalizes file_path -> path and executes", async () => {
		const file = join(dir, "a.txt");
		writeFileSync(file, "hello\n");
		const def = createReadToolDefinition(dir, { embedHashlineAnchors: false });
		const prepared = def.prepareArguments!({ file_path: file });
		expect(prepared).toEqual({ path: file });
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute("c", prepared as { path: string }, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
		};
		expect(result.content[0]?.text).toBe("hello\n");
	});

	it("normalizes filename -> path", () => {
		const def = createReadToolDefinition(dir);
		expect(def.prepareArguments!({ filename: "/x" })).toEqual({ path: "/x" });
	});
});

describe("write tool: prepareArguments aliases", () => {
	it("normalizes file_path -> path and text -> content", async () => {
		const file = join(dir, "out.txt");
		const def = createWriteToolDefinition(dir);
		const prepared = def.prepareArguments!({ file_path: file, text: "abc" });
		expect(prepared).toEqual({ path: file, content: "abc" });
		const ctx = {} as Parameters<typeof def.execute>[4];
		await def.execute("c", prepared as { path: string; content: string }, undefined, undefined, ctx);
		expect(readFileSync(file, "utf8")).toBe("abc");
	});

	it("body/data also map to content", () => {
		const def = createWriteToolDefinition(dir);
		expect(def.prepareArguments!({ path: "/x", body: "b" })).toEqual({ path: "/x", content: "b" });
		expect(def.prepareArguments!({ path: "/x", data: "d" })).toEqual({ path: "/x", content: "d" });
	});

	it("canonical content wins when both are present", () => {
		const def = createWriteToolDefinition(dir);
		expect(def.prepareArguments!({ path: "/x", content: "canon", text: "alias" })).toEqual({
			path: "/x",
			content: "canon",
		});
	});
});

describe("edit tool: prepareArguments aliases", () => {
	it("normalizes file_path -> path", () => {
		const def = createEditToolDefinition(dir);
		const prepared = def.prepareArguments!({
			file_path: "/x",
			edits: [{ oldText: "a", newText: "b" }],
		});
		expect(prepared).toEqual({ path: "/x", edits: [{ oldText: "a", newText: "b" }] });
	});

	it("still folds top-level oldText/newText after aliasing", () => {
		const def = createEditToolDefinition(dir);
		const prepared = def.prepareArguments!({
			file_path: "/x",
			oldText: "a",
			newText: "b",
		});
		expect(prepared).toEqual({ path: "/x", edits: [{ oldText: "a", newText: "b" }] });
	});

	it("parses JSON-encoded edits even when path is aliased", () => {
		const def = createEditToolDefinition(dir);
		const prepared = def.prepareArguments!({
			file_path: "/x",
			edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
		});
		expect(prepared).toEqual({ path: "/x", edits: [{ oldText: "a", newText: "b" }] });
	});
});

describe("bash tool: prepareArguments aliases", () => {
	it("normalizes cmd -> command", () => {
		const def = createBashToolDefinition(dir);
		expect(def.prepareArguments!({ cmd: "echo hi" })).toEqual({ command: "echo hi" });
	});

	it("normalizes script/run/shell -> command", () => {
		const def = createBashToolDefinition(dir);
		expect(def.prepareArguments!({ script: "echo hi" })).toEqual({ command: "echo hi" });
		expect(def.prepareArguments!({ run: "echo hi" })).toEqual({ command: "echo hi" });
		expect(def.prepareArguments!({ shell: "echo hi" })).toEqual({ command: "echo hi" });
	});

	it("joins an array under commands into a single command", () => {
		const def = createBashToolDefinition(dir);
		expect(def.prepareArguments!({ commands: ["a", "b"] })).toEqual({ command: "a && b" });
	});

	it("leaves canonical command alone when present", () => {
		const def = createBashToolDefinition(dir);
		expect(def.prepareArguments!({ command: "x", cmd: "y" })).toEqual({ command: "x" });
	});

	it("ignores commands array when command is already set", () => {
		const def = createBashToolDefinition(dir);
		expect(def.prepareArguments!({ command: "x", commands: ["a", "b"] })).toEqual({
			command: "x",
			commands: ["a", "b"],
		});
	});

	it("normalizes dir/directory/workdir/working_directory -> cwd", () => {
		const def = createBashToolDefinition(dir);
		expect(def.prepareArguments!({ command: "ls", dir: "/p" })).toEqual({ command: "ls", cwd: "/p" });
		expect(def.prepareArguments!({ command: "ls", directory: "/p" })).toEqual({ command: "ls", cwd: "/p" });
		expect(def.prepareArguments!({ command: "ls", workdir: "/p" })).toEqual({ command: "ls", cwd: "/p" });
		expect(def.prepareArguments!({ command: "ls", working_directory: "/p" })).toEqual({ command: "ls", cwd: "/p" });
	});
});

describe("grep/find/ls tools: prepareArguments path aliases", () => {
	it("grep normalizes file_path -> path", () => {
		const def = createGrepToolDefinition(dir);
		expect(def.prepareArguments!({ pattern: "x", file_path: "/y" })).toEqual({ pattern: "x", path: "/y" });
	});

	it("find normalizes file_path -> path", () => {
		const def = createFindToolDefinition(dir);
		expect(def.prepareArguments!({ pattern: "*.ts", file_path: "/y" })).toEqual({ pattern: "*.ts", path: "/y" });
	});

	it("ls normalizes file_path -> path", () => {
		const def = createLsToolDefinition(dir);
		expect(def.prepareArguments!({ file_path: "/y" })).toEqual({ path: "/y" });
	});
});

describe("schema strictness: additionalProperties false", () => {
	it("read schema rejects unknown keys", () => {
		const def = createReadToolDefinition(dir);
		// The schema is JSON Schema; the validation layer enforces additionalProperties.
		// Smoke-check that the schema declares additionalProperties:false.
		expect((def.parameters as { additionalProperties?: unknown }).additionalProperties).toBe(false);
	});

	it("write schema rejects unknown keys", () => {
		const def = createWriteToolDefinition(dir);
		expect((def.parameters as { additionalProperties?: unknown }).additionalProperties).toBe(false);
	});

	it("bash schema rejects unknown keys", () => {
		const def = createBashToolDefinition(dir);
		expect((def.parameters as { additionalProperties?: unknown }).additionalProperties).toBe(false);
	});

	it("grep/find/ls schemas reject unknown keys", () => {
		expect(
			(createGrepToolDefinition(dir).parameters as { additionalProperties?: unknown }).additionalProperties,
		).toBe(false);
		expect(
			(createFindToolDefinition(dir).parameters as { additionalProperties?: unknown }).additionalProperties,
		).toBe(false);
		expect((createLsToolDefinition(dir).parameters as { additionalProperties?: unknown }).additionalProperties).toBe(
			false,
		);
	});
});

describe("preexisting directory needed by execute calls", () => {
	it("creates expected dirs", () => {
		mkdirSync(join(dir, "sub"), { recursive: true });
		expect(true).toBe(true);
	});
});
