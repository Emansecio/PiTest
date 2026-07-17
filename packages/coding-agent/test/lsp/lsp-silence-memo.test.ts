/**
 * Change C — silent-diagnostics short-circuit.
 *
 * A (file + server) key whose diagnostics wait keeps expiring with no qualifying
 * publish is remembered; after the miss threshold, later waits short-circuit to a
 * tiny grace instead of the full budget. Any qualifying publish, a project-loaded
 * transition, config reload, or a TTL invalidates the marker.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getOrCreateClient, shutdownAll } from "../../src/core/lsp/client.ts";
import { getServersForFile } from "../../src/core/lsp/config.ts";
import { getConfig } from "../../src/core/lsp/manager.ts";
import {
	_resetLspSilenceMemoryForTest,
	diagnosticsSilenceKey,
	effectiveDiagnosticsWaitMs,
	recordDiagnosticsWaitOutcome,
	resetDiagnosticsSilenceForClient,
} from "../../src/core/lsp/utils.ts";
import { getPostWriteDiagnostics, setDiagnosticsOnWrite } from "../../src/core/lsp/writethrough.ts";

const UNSAFE_SERVER = fileURLToPath(new URL("./unsafe-lsp-server.mjs", import.meta.url));

const PREV_GRACE = process.env.PIT_LSP_SILENCE_GRACE_MS;
const PREV_DISABLE = process.env.PIT_NO_LSP_SILENCE_MEMO;

function restoreEnv(): void {
	if (PREV_GRACE === undefined) delete process.env.PIT_LSP_SILENCE_GRACE_MS;
	else process.env.PIT_LSP_SILENCE_GRACE_MS = PREV_GRACE;
	if (PREV_DISABLE === undefined) delete process.env.PIT_NO_LSP_SILENCE_MEMO;
	else process.env.PIT_NO_LSP_SILENCE_MEMO = PREV_DISABLE;
}

describe("silence memo helpers", () => {
	afterEach(() => {
		_resetLspSilenceMemoryForTest();
		restoreEnv();
	});

	it("short-circuits only after the miss threshold, and grace is capped by the full budget", () => {
		process.env.PIT_LSP_SILENCE_GRACE_MS = "150";
		const key = diagnosticsSilenceKey("srv", "file:///a.txt");

		expect(effectiveDiagnosticsWaitMs(key, 4000)).toBe(4000); // no entry yet
		recordDiagnosticsWaitOutcome(key, false); // misses = 1
		expect(effectiveDiagnosticsWaitMs(key, 4000)).toBe(4000);
		recordDiagnosticsWaitOutcome(key, false); // misses = 2 → threshold
		expect(effectiveDiagnosticsWaitMs(key, 4000)).toBe(150);
		expect(effectiveDiagnosticsWaitMs(key, 100)).toBe(100); // grace never exceeds budget
	});

	it("resets on a qualifying publish", () => {
		const key = diagnosticsSilenceKey("srv", "file:///a.txt");
		recordDiagnosticsWaitOutcome(key, false);
		recordDiagnosticsWaitOutcome(key, false);
		expect(effectiveDiagnosticsWaitMs(key, 4000)).toBeLessThan(4000);
		recordDiagnosticsWaitOutcome(key, true); // publish arrived
		expect(effectiveDiagnosticsWaitMs(key, 4000)).toBe(4000);
	});

	it("resets a server's keys on its project-loaded transition", () => {
		const key = diagnosticsSilenceKey("srvA", "file:///a.txt");
		const other = diagnosticsSilenceKey("srvB", "file:///b.txt");
		recordDiagnosticsWaitOutcome(key, false);
		recordDiagnosticsWaitOutcome(key, false);
		recordDiagnosticsWaitOutcome(other, false);
		recordDiagnosticsWaitOutcome(other, false);
		resetDiagnosticsSilenceForClient("srvA");
		expect(effectiveDiagnosticsWaitMs(key, 4000)).toBe(4000); // cleared
		expect(effectiveDiagnosticsWaitMs(other, 4000)).toBeLessThan(4000); // untouched
	});

	it("expires an entry after the TTL", () => {
		vi.useFakeTimers();
		try {
			const key = diagnosticsSilenceKey("srv", "file:///a.txt");
			recordDiagnosticsWaitOutcome(key, false);
			recordDiagnosticsWaitOutcome(key, false);
			expect(effectiveDiagnosticsWaitMs(key, 4000)).toBeLessThan(4000);
			vi.advanceTimersByTime(5 * 60_000 + 1); // past the 5-minute TTL
			expect(effectiveDiagnosticsWaitMs(key, 4000)).toBe(4000);
		} finally {
			vi.useRealTimers();
		}
	});

	it("kill-switch PIT_NO_LSP_SILENCE_MEMO=1 keeps the full wait", () => {
		process.env.PIT_NO_LSP_SILENCE_MEMO = "1";
		const key = diagnosticsSilenceKey("srv", "file:///a.txt");
		recordDiagnosticsWaitOutcome(key, false);
		recordDiagnosticsWaitOutcome(key, false);
		recordDiagnosticsWaitOutcome(key, false);
		expect(effectiveDiagnosticsWaitMs(key, 4000)).toBe(4000);
	});
});

describe("silence memo — writethrough integration", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pit-lsp-silence-"));

	beforeAll(async () => {
		writeFileSync(
			join(cwd, "lsp.json"),
			JSON.stringify({
				servers: {
					unsafe: { command: "node", args: [UNSAFE_SERVER], fileTypes: [".txt"], rootMarkers: ["lsp.json"] },
				},
			}),
		);
		// Warm the client so the timing below measures the diagnostics wait, not boot.
		const warm = join(cwd, "warm.txt");
		writeFileSync(warm, "hello\n");
		const servers = getServersForFile(getConfig(cwd), warm);
		await Promise.all(servers.map(([, config]) => getOrCreateClient(config, cwd, 15_000)));
	});

	afterAll(async () => {
		await shutdownAll();
		rmSync(cwd, { recursive: true, force: true });
		restoreEnv();
	});

	afterEach(() => {
		setDiagnosticsOnWrite(false);
		_resetLspSilenceMemoryForTest();
		restoreEnv();
	});

	it("short-circuits the wait once a silent file has crossed the threshold", async () => {
		setDiagnosticsOnWrite(true);
		process.env.PIT_LSP_SILENCE_GRACE_MS = "50";
		const path = join(cwd, "silent.txt");
		writeFileSync(path, "NO_PUBLISH\n"); // unsafe server never publishes for this text

		const timeoutMs = 500;
		const timed = async (): Promise<number> => {
			const start = Date.now();
			await getPostWriteDiagnostics(path, "NO_PUBLISH\n", cwd, undefined, { timeoutMs });
			return Date.now() - start;
		};

		const first = await timed(); // full wait, miss #1
		const second = await timed(); // full wait, miss #2 → threshold reached
		const third = await timed(); // short-circuited to ~50ms grace

		expect(first).toBeGreaterThanOrEqual(400);
		expect(second).toBeGreaterThanOrEqual(400);
		expect(third).toBeLessThan(250);
		expect(third).toBeLessThan(first - 150);
	});

	it("kill-switch PIT_NO_LSP_SILENCE_MEMO=1 keeps paying the full wait", async () => {
		setDiagnosticsOnWrite(true);
		process.env.PIT_NO_LSP_SILENCE_MEMO = "1";
		const path = join(cwd, "silent2.txt");
		writeFileSync(path, "NO_PUBLISH\n");

		const timeoutMs = 400;
		const timed = async (): Promise<number> => {
			const start = Date.now();
			await getPostWriteDiagnostics(path, "NO_PUBLISH\n", cwd, undefined, { timeoutMs });
			return Date.now() - start;
		};

		await timed();
		await timed();
		const third = await timed();
		expect(third).toBeGreaterThanOrEqual(300); // no short-circuit
	});
});
