import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getOrCreateClient, shutdownAll } from "../../src/core/lsp/client.ts";
import { getServersForFile } from "../../src/core/lsp/config.ts";
import {
	clearDiagnosticsLedger,
	diagnosticIdentity,
	reduceByDiagnosticsLedger,
} from "../../src/core/lsp/diagnostics-ledger.ts";
import { getConfig } from "../../src/core/lsp/manager.ts";
import type { Diagnostic } from "../../src/core/lsp/types.ts";
import {
	clearPostWriteBaselineCache,
	setDiagnosticsOnWrite,
	setEnforceDiagnosticsOnWrite,
	setFormatOnWrite,
} from "../../src/core/lsp/writethrough.ts";
import { createWriteToolDefinition } from "../../src/core/tools/write.ts";

const URI = "file:///proj/a.ts";

function diag(message: string, line: number, extra?: Partial<Diagnostic>): Diagnostic {
	return {
		range: { start: { line, character: 0 }, end: { line, character: 4 } },
		severity: 1,
		source: "fake",
		message,
		...extra,
	};
}

describe("diagnostics ledger — identity", () => {
	it("ignores the range: the same problem at another line shares an identity", () => {
		expect(diagnosticIdentity(diag("boom", 0))).toBe(diagnosticIdentity(diag("boom", 41)));
	});

	it("separates message, severity, code and source", () => {
		const base = diag("boom", 0);
		expect(diagnosticIdentity(base)).not.toBe(diagnosticIdentity(diag("bang", 0)));
		expect(diagnosticIdentity(base)).not.toBe(diagnosticIdentity(diag("boom", 0, { severity: 2 })));
		expect(diagnosticIdentity(base)).not.toBe(diagnosticIdentity(diag("boom", 0, { code: "TS1" })));
		expect(diagnosticIdentity(base)).not.toBe(diagnosticIdentity(diag("boom", 0, { source: "other" })));
	});

	it("does not let a field's content forge a field boundary", () => {
		// Same concatenation if the parts were joined on a printable separator.
		const a = diag("x", 0, { source: "a", code: "b" });
		const b = diag("x", 0, { source: "a b", code: "" });
		expect(diagnosticIdentity(a)).not.toBe(diagnosticIdentity(b));
	});
});

describe("diagnostics ledger — reduce", () => {
	beforeEach(() => {
		clearDiagnosticsLedger();
		delete process.env.PIT_NO_LSP_DIAG_LEDGER;
	});

	it("reports everything on first sight of a file", () => {
		const d = [diag("boom", 0)];
		expect(reduceByDiagnosticsLedger(URI, d, d)).toHaveLength(1);
	});

	it("suppresses a repeat whose line moved", () => {
		const first = [diag("boom", 0)];
		reduceByDiagnosticsLedger(URI, first, first);
		const moved = [diag("boom", 7)];
		expect(reduceByDiagnosticsLedger(URI, moved, moved)).toEqual([]);
	});

	it("remembers what the baseline filter already suppressed", () => {
		// Observed carries the diagnostic; the caller reports nothing this write.
		const observed = [diag("boom", 0)];
		expect(reduceByDiagnosticsLedger(URI, observed, [])).toEqual([]);
		// Next write shifts it — the baseline filter lets it through, the ledger must not.
		const moved = [diag("boom", 7)];
		expect(reduceByDiagnosticsLedger(URI, moved, moved)).toEqual([]);
	});

	it("re-reports a diagnostic that was fixed and then reintroduced", () => {
		const d = [diag("boom", 0)];
		reduceByDiagnosticsLedger(URI, d, d);
		// Clean observation clears the file's memory.
		expect(reduceByDiagnosticsLedger(URI, [], [])).toEqual([]);
		expect(reduceByDiagnosticsLedger(URI, d, d)).toHaveLength(1);
	});

	it("lets a genuinely new diagnostic through alongside a suppressed one", () => {
		const first = [diag("boom", 0)];
		reduceByDiagnosticsLedger(URI, first, first);
		const next = [diag("boom", 0), diag("bang", 3)];
		const out = reduceByDiagnosticsLedger(URI, next, next);
		expect(out.map((d) => d.message)).toEqual(["bang"]);
	});

	it("keeps files independent", () => {
		const d = [diag("boom", 0)];
		reduceByDiagnosticsLedger(URI, d, d);
		expect(reduceByDiagnosticsLedger("file:///proj/other.ts", d, d)).toHaveLength(1);
	});

	it("never mutates the arrays it is handed", () => {
		const observed = [diag("boom", 0)];
		const candidates = [diag("boom", 0)];
		reduceByDiagnosticsLedger(URI, observed, candidates);
		expect(observed).toHaveLength(1);
		expect(candidates).toHaveLength(1);
	});

	it("kill-switch PIT_NO_LSP_DIAG_LEDGER=1 re-reports every write", () => {
		process.env.PIT_NO_LSP_DIAG_LEDGER = "1";
		const d = [diag("boom", 0)];
		expect(reduceByDiagnosticsLedger(URI, d, d)).toHaveLength(1);
		expect(reduceByDiagnosticsLedger(URI, d, d)).toHaveLength(1);
	});
});

// =============================================================================
// Integration: the real write tool against the fake server
// =============================================================================

const FAKE_SERVER = fileURLToPath(new URL("./fake-lsp-server.mjs", import.meta.url));

type ToolResult = { content: Array<{ type: string; text?: string }> };

function makeProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pit-ledger-"));
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
	const result = (await def.execute("w", { path, content }, undefined, undefined, ctx)) as ToolResult;
	return result.content[0]?.text ?? "";
}

describe("diagnostics ledger — writethrough integration", () => {
	const cwd = makeProject();

	beforeAll(async () => {
		const warmPath = join(cwd, "warm.txt");
		writeFileSync(warmPath, "hello\n");
		const servers = getServersForFile(getConfig(cwd), warmPath);
		await Promise.all(servers.map(([, config]) => getOrCreateClient(config, cwd, 15_000)));
	});

	beforeEach(() => {
		clearDiagnosticsLedger();
		clearPostWriteBaselineCache();
		delete process.env.PIT_NO_LSP_DIAG_LEDGER;
		setDiagnosticsOnWrite(true);
		setEnforceDiagnosticsOnWrite(true);
		setFormatOnWrite(false);
	});

	afterEach(() => {
		setDiagnosticsOnWrite(false);
		delete process.env.PIT_NO_LSP_DIAG_LEDGER;
	});

	afterAll(async () => {
		await shutdownAll();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("suppresses a pre-existing error whose line the edit merely shifted", async () => {
		const first = await runWrite(cwd, "shift.txt", "DIAG_LINE 0\n");
		expect(first).toContain("fake diagnostic");

		// Same problem, new line. The baseline filter fingerprints the range and so
		// would report it as introduced by this write; the ledger must not.
		const second = await runWrite(cwd, "shift.txt", "padding\nDIAG_LINE 3\n");
		expect(second).toContain("Successfully wrote");
		expect(second).not.toContain("fake diagnostic");
		expect(second).not.toContain("Fix the error(s) below");
	});

	it("kill-switch restores the old (re-reporting) behaviour for the same shift", async () => {
		process.env.PIT_NO_LSP_DIAG_LEDGER = "1";
		const first = await runWrite(cwd, "shift-off.txt", "DIAG_LINE 0\n");
		expect(first).toContain("fake diagnostic");

		const second = await runWrite(cwd, "shift-off.txt", "padding\nDIAG_LINE 3\n");
		// Proves the suppression in the test above comes from the ledger and not
		// from the baseline filter happening to catch it.
		expect(second).toContain("fake diagnostic");
	});
});
