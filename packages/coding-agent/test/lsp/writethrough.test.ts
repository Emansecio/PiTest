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
		process.env.PIT_NO_LSP_CROSS_FILE_SURFACE = undefined;
		delete process.env.PIT_NO_LSP_CROSS_FILE_SURFACE;
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

	it("surfaces a NEW cross-file error introduced by the write (edited file excluded)", async () => {
		setDiagnosticsOnWrite(true);
		// Establish a clean baseline for the sibling first (no cross-file yet).
		const first = await runWrite(cwd, "cf-edit.txt", "CROSS_CLEAR cf-victim.txt\n");
		expect(first).not.toContain("cross-file:");
		// Now the same edit introduces a fresh error in the sibling.
		const out = await runWrite(cwd, "cf-edit.txt", "CROSS_ERROR cf-victim.txt\n");
		expect(out).toContain("cross-file: cf-victim.txt — 1 new error(s):");
		expect(out).toContain("cross error 0 in cf-victim.txt");
		// The edited file is never reported as a cross-file entry.
		expect(out).not.toContain("cross-file: cf-edit.txt");
	});

	it("does not resurface a PRE-EXISTING cross-file error", async () => {
		setDiagnosticsOnWrite(true);
		// Write #1 seeds the sibling error into the baseline.
		await runWrite(cwd, "cf-edit2.txt", "CROSS_ERROR cf-pre.txt\n");
		// Write #2 republishes the SAME error — it must not be surfaced again.
		const out = await runWrite(cwd, "cf-edit2.txt", "CROSS_ERROR cf-pre.txt\n");
		expect(out).not.toContain("cross-file:");
	});

	it("bounds cross-file output to 3 files and 2 diagnostics each", async () => {
		setDiagnosticsOnWrite(true);
		const out = await runWrite(
			cwd,
			"cf-edit3.txt",
			["CROSS_ERROR cf1.txt 5", "CROSS_ERROR cf2.txt 5", "CROSS_ERROR cf3.txt 5", "CROSS_ERROR cf4.txt 5", ""].join(
				"\n",
			),
		);
		// Max 3 files (4th dropped), first-published win by map order.
		const fileLines = out.split("\n").filter((l) => l.startsWith("cross-file:"));
		expect(fileLines).toHaveLength(3);
		expect(out).toContain("cross-file: cf1.txt");
		expect(out).toContain("cross-file: cf2.txt");
		expect(out).toContain("cross-file: cf3.txt");
		expect(out).not.toContain("cross-file: cf4.txt");
		// Header keeps the true count, but only 2 diagnostics are shown per file.
		expect(out).toContain("cf1.txt — 5 new error(s):");
		expect(out).toContain("cross error 1 in cf1.txt");
		expect(out).not.toContain("cross error 2 in cf1.txt");
	});

	it("kill-switch PIT_NO_LSP_CROSS_FILE_SURFACE=1 reverts to edited-file-only", async () => {
		setDiagnosticsOnWrite(true);
		process.env.PIT_NO_LSP_CROSS_FILE_SURFACE = "1";
		const out = await runWrite(cwd, "cf-ks.txt", "CROSS_ERROR cf-ks-victim.txt\n");
		expect(out).not.toContain("cross-file:");
		// Edited-file diagnostics still flow.
		expect(out).toContain("fake diagnostic");
	});
});
