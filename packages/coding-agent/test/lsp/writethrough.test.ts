import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getOrCreateClient, shutdownAll } from "../../src/core/lsp/client.ts";
import { getServersForFile } from "../../src/core/lsp/config.ts";
import { getConfig } from "../../src/core/lsp/manager.ts";
import {
	setDiagnosticsOnWrite,
	setEnforceDiagnosticsOnWrite,
	setFormatOnWrite,
} from "../../src/core/lsp/writethrough.ts";
import { createEditToolDefinition } from "../../src/core/tools/edit.ts";
import { createWriteToolDefinition } from "../../src/core/tools/write.ts";

const FAKE_SERVER = fileURLToPath(new URL("./fake-lsp-server.mjs", import.meta.url));

type ToolResult = { content: Array<{ type: string; text?: string }> };

function text(result: unknown): string {
	return (result as ToolResult).content[0]?.text ?? "";
}

function makeProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pit-wt-"));
	writeFileSync(
		join(cwd, "lsp.json"),
		JSON.stringify({
			servers: { fake: { command: "node", args: [FAKE_SERVER], fileTypes: [".txt"], rootMarkers: ["lsp.json"] } },
		}),
	);
	return cwd;
}

async function runWrite(cwd: string, path: string, content: string): Promise<string> {
	const def = createWriteToolDefinition(cwd);
	const ctx = {} as Parameters<typeof def.execute>[4];
	return text(await def.execute("w", { path, content }, undefined, undefined, ctx));
}

async function runEdit(cwd: string, path: string, oldText: string, newText: string): Promise<string> {
	const def = createEditToolDefinition(cwd);
	const ctx = {} as Parameters<typeof def.execute>[4];
	return text(await def.execute("e", { path, edits: [{ oldText, newText }] }, undefined, undefined, ctx));
}

describe("lsp writethrough — post-write diagnostics", () => {
	const cwd = makeProject();

	beforeAll(async () => {
		const warmPath = join(cwd, "warm.txt");
		writeFileSync(warmPath, "hello\n");
		const servers = getServersForFile(getConfig(cwd), warmPath);
		await Promise.all(servers.map(([, config]) => getOrCreateClient(config, cwd, 15_000)));
	});

	afterEach(() => {
		setDiagnosticsOnWrite(false);
		setEnforceDiagnosticsOnWrite(true);
		setFormatOnWrite(false);
	});

	afterAll(async () => {
		await shutdownAll();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("format-on-write rewrites the file via LSP when enabled", async () => {
		setDiagnosticsOnWrite(false);
		setFormatOnWrite(true);
		const out = await runWrite(cwd, "fmt.txt", "hello\n");
		expect(out).toContain("(formatted)");
		expect(readFileSync(join(cwd, "fmt.txt"), "utf-8")).toBe("/* fmt */ hello\n");
	});

	it("write attaches LSP diagnostics (imperative framing on error) when enabled", async () => {
		setDiagnosticsOnWrite(true);
		const out = await runWrite(cwd, "a.txt", "hello world\n");
		expect(out).toContain("Successfully wrote");
		// Error-severity diagnostic → active directive, not a passive note.
		expect(out).toContain("Fix the error(s) below");
		expect(out).toContain("fake diagnostic");
		// File was still written normally.
		expect(readFileSync(join(cwd, "a.txt"), "utf-8")).toBe("hello world\n");
	});

	it("does not re-append unchanged baseline diagnostics", async () => {
		setDiagnosticsOnWrite(true);
		setEnforceDiagnosticsOnWrite(true);
		const first = await runWrite(cwd, "baseline.txt", "hello world\n");
		expect(first).toContain("fake diagnostic");

		const second = await runWrite(cwd, "baseline.txt", "hello again\n");
		expect(second).toContain("Successfully wrote");
		expect(second).not.toContain("fake diagnostic");
		expect(second).not.toContain("Fix the error(s) below");
	});

	it("edit suppresses unchanged baseline diagnostics when enabled", async () => {
		setDiagnosticsOnWrite(true);
		writeFileSync(join(cwd, "b.txt"), "foo bar\n");
		const out = await runEdit(cwd, "b.txt", "foo", "FOO");
		expect(out).toContain("Successfully replaced 1 block(s)");
		expect(out).not.toContain("Fix the error(s) below");
		expect(out).not.toContain("fake diagnostic");
		expect(readFileSync(join(cwd, "b.txt"), "utf-8")).toBe("FOO bar\n");
	});

	it("uses the neutral framing when enforcement is disabled", async () => {
		setDiagnosticsOnWrite(true);
		setEnforceDiagnosticsOnWrite(false);
		const out = await runWrite(cwd, "a2.txt", "hello world\n");
		expect(out).toContain("LSP diagnostics");
		expect(out).toContain("fake diagnostic");
		expect(out).not.toContain("Fix the error(s) below");
	});

	it("no diagnostics appended when disabled", async () => {
		setDiagnosticsOnWrite(false);
		const out = await runWrite(cwd, "c.txt", "nothing extra\n");
		expect(out).toContain("Successfully wrote");
		expect(out).not.toContain("LSP diagnostics");
	});

	it("no diagnostics for files without a configured server", async () => {
		setDiagnosticsOnWrite(true);
		// .md is not in fileTypes for the fake server → no-op, plain result.
		const out = await runWrite(cwd, "d.md", "# title\n");
		expect(out).toContain("Successfully wrote");
		expect(out).not.toContain("LSP diagnostics");
	});
});
