/**
 * P1-3 — the two diagnostics waits every edit used to pay in series.
 *
 * Part 1 (wake-by-event): `waitForDiagnosticsResult` is woken by the
 * `publishDiagnostics` handler instead of polling on `sleep(100)`. These tests
 * drive the REAL handler (`routeMessage`) against a stub client, so they cover
 * the wiring, not just the utility.
 *
 * Part 2 (baseline reuse): a pre-write capture for a file whose bytes have not
 * moved since the last successful post-write collection returns that result
 * immediately instead of waiting for a fresh publish of the old content.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getOrCreateClient, routeMessage, shutdownAll } from "../../src/core/lsp/client.ts";
import { getServersForFile } from "../../src/core/lsp/config.ts";
import { _diagnosticsWaiterCountForTest } from "../../src/core/lsp/diagnostics-events.ts";
import { getConfig } from "../../src/core/lsp/manager.ts";
import type { Diagnostic, LspClient } from "../../src/core/lsp/types.ts";
import {
	_resetLspSilenceMemoryForTest,
	fileToUri,
	waitForDiagnosticsResult,
	waitForNextDiagnosticsPublish,
} from "../../src/core/lsp/utils.ts";
import {
	capturePreWriteDiagnostics,
	clearPostWriteBaselineCache,
	getPostWriteDiagnostics,
	setDiagnosticsOnWrite,
} from "../../src/core/lsp/writethrough.ts";

const FAKE_SERVER = fileURLToPath(new URL("./fake-lsp-server.mjs", import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal client: the wait only reads `diagnostics` + `diagnosticsVersion`. */
function stubClient(): LspClient {
	return { diagnostics: new Map(), diagnosticsVersion: 0 } as unknown as LspClient;
}

function diagnostic(message: string): Diagnostic {
	return { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message };
}

/** Feed a publishDiagnostics notification through the real message router. */
async function publish(client: LspClient, uri: string, message: string, version?: number): Promise<void> {
	await routeMessage(client, {
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: { uri, diagnostics: [diagnostic(message)], ...(version === undefined ? {} : { version }) },
	});
}

describe("waitForDiagnosticsResult — wake by publish event", () => {
	const uri = fileToUri(join(tmpdir(), "pit-wake", "a.txt"));

	it("resolves as soon as the publish lands, not on the next poll tick", async () => {
		const client = stubClient();
		const started = Date.now();
		const waiting = waitForDiagnosticsResult(client, uri, { timeoutMs: 4000, minVersion: 0 });
		// Let the synchronous pre-check run first, so the publish can only be seen
		// through the event path. The old loop would have slept until t=100ms.
		await sleep(10);
		await publish(client, uri, "woke up");

		const result = await waiting;
		const elapsed = Date.now() - started;
		expect(result.fresh).toBe(true);
		expect(result.diagnostics.map((d) => d.message)).toEqual(["woke up"]);
		expect(elapsed).toBeLessThan(80);
		expect(_diagnosticsWaiterCountForTest(client)).toBe(0);
	});

	it("returns fresh: false and drops its waiter when the budget expires silently", async () => {
		const client = stubClient();
		const started = Date.now();
		const result = await waitForDiagnosticsResult(client, uri, { timeoutMs: 80, minVersion: 0 });
		expect(result).toEqual({ diagnostics: [], fresh: false });
		expect(Date.now() - started).toBeGreaterThanOrEqual(70);
		expect(_diagnosticsWaiterCountForTest(client)).toBe(0);
	});

	it("returns an already-satisfied result without waiting at all", async () => {
		const client = stubClient();
		await publish(client, uri, "already here");
		const started = Date.now();
		const result = await waitForDiagnosticsResult(client, uri, { timeoutMs: 4000, minVersion: 0 });
		expect(result.fresh).toBe(true);
		expect(Date.now() - started).toBeLessThan(50);
	});

	it("throws on abort and removes the waiter", async () => {
		const client = stubClient();
		const controller = new AbortController();
		const waiting = waitForDiagnosticsResult(client, uri, { timeoutMs: 5000, signal: controller.signal });
		await sleep(10);
		expect(_diagnosticsWaiterCountForTest(client)).toBe(1);
		controller.abort();
		await expect(waiting).rejects.toThrow();
		expect(_diagnosticsWaiterCountForTest(client)).toBe(0);
	});

	it("is not woken by a publish for another file (minVersion alone is not enough)", async () => {
		const client = stubClient();
		const waiting = waitForDiagnosticsResult(client, uri, { timeoutMs: 120, minVersion: 0 });
		await sleep(10);
		await publish(client, fileToUri(join(tmpdir(), "pit-wake", "other.txt")), "elsewhere");
		expect(client.diagnosticsVersion).toBe(1); // the version DID move
		expect(await waiting).toEqual({ diagnostics: [], fresh: false });
		expect(_diagnosticsWaiterCountForTest(client)).toBe(0);
	});

	it("keeps waiting through a version-mismatched publish and resolves on the matching one", async () => {
		const client = stubClient();
		const waiting = waitForDiagnosticsResult(client, uri, {
			timeoutMs: 4000,
			minVersion: 0,
			expectedDocumentVersion: 7,
			allowUnversioned: false,
		});
		await sleep(10);
		await publish(client, uri, "stale", 6);
		await sleep(10);
		await publish(client, uri, "current", 7);
		const result = await waiting;
		expect(result.fresh).toBe(true);
		expect(result.diagnostics.map((d) => d.message)).toEqual(["current"]);
		expect(_diagnosticsWaiterCountForTest(client)).toBe(0);
	});

	it("treats a deadline abort as a miss, not a cancellation", async () => {
		// Writethrough hands the wait `AbortSignal.any([caller, AbortSignal.timeout])`
		// where the deadline duplicates the budget. The old poll loop only sampled the
		// signal every 100ms and so never saw its own deadline fire; waking instantly
		// would have turned every silent wait into a throw — killing the silence memo's
		// miss bookkeeping.
		const client = stubClient();
		const result = await waitForDiagnosticsResult(client, uri, {
			timeoutMs: 4000,
			signal: AbortSignal.timeout(30),
			minVersion: 0,
		});
		expect(result).toEqual({ diagnostics: [], fresh: false });
		expect(_diagnosticsWaiterCountForTest(client)).toBe(0);
	});

	it("does not throw on an already-aborted signal when the budget is non-positive", async () => {
		const client = stubClient();
		await publish(client, uri, "cached");
		const result = await waitForDiagnosticsResult(client, uri, { timeoutMs: 0, signal: AbortSignal.abort() });
		expect(result.fresh).toBe(true);
	});
});

describe("waitForNextDiagnosticsPublish — cross-file settle window", () => {
	it("returns as soon as any further publish lands", async () => {
		const client = stubClient();
		const started = Date.now();
		const waiting = waitForNextDiagnosticsPublish(client, 2000);
		await sleep(10);
		await publish(client, fileToUri(join(tmpdir(), "pit-settle", "sibling.txt")), "package error");

		expect(await waiting).toBe(true);
		expect(Date.now() - started).toBeLessThan(80);
		expect(_diagnosticsWaiterCountForTest(client)).toBe(0);
	});

	it("gives up after the window with no further publish, and never throws", async () => {
		const client = stubClient();
		expect(await waitForNextDiagnosticsPublish(client, 40)).toBe(false);
		expect(await waitForNextDiagnosticsPublish(client, 40, AbortSignal.abort())).toBe(false);
		expect(await waitForNextDiagnosticsPublish(client, 0)).toBe(false);
		expect(_diagnosticsWaiterCountForTest(client)).toBe(0);
	});
});

describe("writethrough — pre-write baseline reuse", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pit-lsp-baseline-"));
	const PREV_DISABLE = process.env.PIT_NO_LSP_BASELINE_REUSE;

	beforeAll(async () => {
		writeFileSync(
			join(cwd, "lsp.json"),
			JSON.stringify({
				servers: { fake: { command: "node", args: [FAKE_SERVER], fileTypes: [".txt"], rootMarkers: ["lsp.json"] } },
			}),
		);
		const warm = join(cwd, "warm.txt");
		writeFileSync(warm, "hello\n");
		const servers = getServersForFile(getConfig(cwd), warm);
		await Promise.all(servers.map(([, config]) => getOrCreateClient(config, cwd, 15_000)));
	});

	beforeEach(() => {
		setDiagnosticsOnWrite(true);
		clearPostWriteBaselineCache();
		_resetLspSilenceMemoryForTest();
	});

	afterEach(() => {
		setDiagnosticsOnWrite(false);
		clearPostWriteBaselineCache();
		_resetLspSilenceMemoryForTest();
		if (PREV_DISABLE === undefined) delete process.env.PIT_NO_LSP_BASELINE_REUSE;
		else process.env.PIT_NO_LSP_BASELINE_REUSE = PREV_DISABLE;
	});

	afterAll(async () => {
		await shutdownAll();
		rmSync(cwd, { recursive: true, force: true });
	});

	/**
	 * Seed the cache the way a real edit does: land bytes on disk, then collect
	 * post-write diagnostics for them.
	 */
	async function seed(path: string, content: string): Promise<void> {
		writeFileSync(path, content);
		const diag = await getPostWriteDiagnostics(path, content, cwd);
		expect(diag).toBeDefined();
	}

	// An already-aborted signal makes every real LSP round-trip impossible
	// (refreshFile throws immediately), so a `fresh: true` answer can ONLY have
	// come from the cache — no timing assertion needed.
	const captureWithoutLsp = (path: string) => capturePreWriteDiagnostics(path, cwd, AbortSignal.abort());

	it("skips the pre-write wait when the file has not moved since the last post-write", async () => {
		const path = join(cwd, "reuse.txt");
		await seed(path, "hello world\n");

		const baseline = await captureWithoutLsp(path);
		expect(baseline?.fresh).toBe(true);
		expect(baseline?.diagnostics.map((d) => d.message)).toEqual(["fake diagnostic"]);
	});

	it("does NOT skip when the file changed on disk", async () => {
		const path = join(cwd, "changed.txt");
		await seed(path, "hello world\n");
		const before = statSync(path).mtimeMs;

		writeFileSync(path, "a different length of content\n");
		expect(statSync(path).size).not.toBe("hello world\n".length);

		// Cache entry is stale → falls through to the real (here: impossible) wait.
		expect(await captureWithoutLsp(path)).toEqual({ diagnostics: [], fresh: false });
		// Sanity: the real path still works with a live signal and a full budget.
		const live = await capturePreWriteDiagnostics(path, cwd);
		expect(live?.fresh).toBe(true);
		expect(before).toBeDefined();
	});

	it("re-arms the cache after every successful post-write collection", async () => {
		const path = join(cwd, "chain.txt");
		await seed(path, "first\n");
		expect((await captureWithoutLsp(path))?.fresh).toBe(true);
		// Second edit of the same file lands new bytes and re-caches them.
		await seed(path, "second edit\n");
		expect((await captureWithoutLsp(path))?.fresh).toBe(true);
	});

	it("kill-switch PIT_NO_LSP_BASELINE_REUSE=1 restores the unconditional wait", async () => {
		const path = join(cwd, "killswitch.txt");
		await seed(path, "hello world\n");
		process.env.PIT_NO_LSP_BASELINE_REUSE = "1";
		expect(await captureWithoutLsp(path)).toEqual({ diagnostics: [], fresh: false });
	});

	it("never reuses across a missing file (fresh empty baseline, no cache read)", async () => {
		const path = join(cwd, "absent.txt");
		expect(await capturePreWriteDiagnostics(path, cwd)).toEqual({ diagnostics: [], fresh: true });
	});
});
