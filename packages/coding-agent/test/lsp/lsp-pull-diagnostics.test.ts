import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { documentDiagnosticsPull, shutdownAll, supportsDocumentDiagnostics } from "../../src/core/lsp/client.ts";
import { clearDiagnosticsLedger } from "../../src/core/lsp/diagnostics-ledger.ts";
import type { LspClient } from "../../src/core/lsp/types.ts";
import {
	clearPostWriteBaselineCache,
	setDiagnosticsOnWrite,
	setEnforceDiagnosticsOnWrite,
	setFormatOnWrite,
} from "../../src/core/lsp/writethrough.ts";
import { createWriteToolDefinition } from "../../src/core/tools/write.ts";

const FAKE_SERVER = fileURLToPath(new URL("./fake-lsp-server.mjs", import.meta.url));

type ToolResult = { content: Array<{ type: string; text?: string }> };

/** Project whose only server is the fake one, spawned with `extraArgs`. */
function makeProject(prefix: string, extraArgs: string[]): string {
	const cwd = mkdtempSync(join(tmpdir(), prefix));
	writeFileSync(
		join(cwd, "lsp.json"),
		JSON.stringify({
			servers: {
				fake: {
					command: "node",
					args: [FAKE_SERVER, ...extraArgs],
					fileTypes: [".txt"],
					rootMarkers: ["lsp.json"],
				},
			},
		}),
	);
	return cwd;
}

async function runWrite(cwd: string, path: string, content: string): Promise<string> {
	const def = createWriteToolDefinition(cwd);
	const ctx = {} as Parameters<typeof def.execute>[4];
	const result = (await def.execute("w", { path, content }, undefined, undefined, ctx)) as ToolResult;
	return result.content[0]?.text ?? "";
}

describe("pull diagnostics — capability detection", () => {
	function clientWith(capabilities: LspClient["serverCapabilities"]): LspClient {
		return { serverCapabilities: capabilities } as LspClient;
	}

	it("is off when the server advertises nothing", () => {
		expect(supportsDocumentDiagnostics(clientWith(undefined))).toBe(false);
		expect(supportsDocumentDiagnostics(clientWith({}))).toBe(false);
	});

	it("is on when the server advertises diagnosticProvider", () => {
		expect(supportsDocumentDiagnostics(clientWith({ diagnosticProvider: { interFileDependencies: false } }))).toBe(
			true,
		);
	});

	it("kill-switch PIT_NO_LSP_PULL_DIAGNOSTICS=1 forces the push-only wait back", () => {
		const client = clientWith({ diagnosticProvider: true });
		process.env.PIT_NO_LSP_PULL_DIAGNOSTICS = "1";
		try {
			expect(supportsDocumentDiagnostics(client)).toBe(false);
			expect(documentDiagnosticsPull(client, "file:///a.ts")).toBeUndefined();
		} finally {
			delete process.env.PIT_NO_LSP_PULL_DIAGNOSTICS;
		}
		expect(supportsDocumentDiagnostics(client)).toBe(true);
	});

	it("hands back no probe at all for a push-only server, leaving the wait untouched", () => {
		expect(documentDiagnosticsPull(clientWith({}), "file:///a.ts")).toBeUndefined();
		expect(documentDiagnosticsPull(clientWith({ diagnosticProvider: true }), "file:///a.ts")).toBeTypeOf("function");
	});
});

describe("pull diagnostics — writethrough integration", () => {
	// Pull-only: advertises the capability, answers the request, NEVER publishes.
	// A push-only client would come back empty from this server.
	const pullCwd = makeProject("pit-pull-", ["--pull"]);
	// Advertises the capability, FAILS every pull, then publishes late.
	const brokenCwd = makeProject("pit-pullbroken-", ["--pull-broken"]);

	beforeEach(() => {
		clearDiagnosticsLedger();
		clearPostWriteBaselineCache();
		setDiagnosticsOnWrite(true);
		setEnforceDiagnosticsOnWrite(true);
		setFormatOnWrite(false);
	});

	afterAll(async () => {
		setDiagnosticsOnWrite(false);
		await shutdownAll();
		rmSync(pullCwd, { recursive: true, force: true });
		rmSync(brokenCwd, { recursive: true, force: true });
	});

	it("collects diagnostics from a server that only answers pulls", async () => {
		const out = await runWrite(pullCwd, "a.txt", "hello world\n");
		expect(out).toContain("Successfully wrote");
		// Before pull support this server was indistinguishable from a silent one.
		expect(out).toContain("fake diagnostic");
		expect(out).toContain("Fix the error(s) below");
	});

	it("still waits for the push when the pull fails", async () => {
		const out = await runWrite(brokenCwd, "b.txt", "hello world\n");
		expect(out).toContain("Successfully wrote");
		// The pull errors almost immediately; the publish lands ~120ms later. If a
		// failed pull were allowed to end the wait, this would come back empty.
		expect(out).toContain("fake diagnostic");
	});
});
