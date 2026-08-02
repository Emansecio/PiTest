/**
 * Unversioned publishes and the stale-diagnostic hole.
 *
 * A server that stamps its publishes with the document version is easy: an exact
 * match is authoritative and accepted at once. A server that publishes WITHOUT a
 * version — every linter in `defaults.ts` (biome, eslint, ruff, rubocop,
 * swiftlint) — gives us nothing to compare, so the first publish to land after
 * our didChange used to be accepted as fresh. When the server had an analysis of
 * the PRE-edit content still in flight, that publish is exactly the wrong one.
 *
 * The consequence is not merely a late diagnostic: post-write framing is
 * imperative ("This change introduced N error(s) — fix them"), and the
 * pre-write baseline filter compares against it, so a stale accept can just as
 * easily HIDE the error the edit really introduced.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { routeMessage } from "../../src/core/lsp/client.ts";
import type { Diagnostic, LspClient } from "../../src/core/lsp/types.ts";
import { fileToUri, waitForDiagnosticsResult, waitForNextDiagnosticsPublish } from "../../src/core/lsp/utils.ts";

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

const uri = fileToUri(join(tmpdir(), "pit-settle", "a.ts"));

describe("unversioned publishes settle before being accepted", () => {
	it("does not accept an in-flight publish computed from the pre-edit content", async () => {
		const client = stubClient();
		// We synced document version 2; the server does not echo versions.
		const waiting = waitForDiagnosticsResult(client, uri, {
			timeoutMs: 3000,
			minVersion: 0,
			expectedDocumentVersion: 2,
		});
		await sleep(10);
		// The analysis that was already running when our didChange landed.
		await publish(client, uri, "stale: computed from v1");
		await sleep(40);
		// The answer for the content actually on disk.
		await publish(client, uri, "fresh: computed from v2");

		const result = await waiting;
		expect(result.fresh).toBe(true);
		expect(result.diagnostics.map((d) => d.message)).toEqual(["fresh: computed from v2"]);
	});

	it("still accepts a version-matched publish immediately, paying no settle", async () => {
		const client = stubClient();
		const started = Date.now();
		const waiting = waitForDiagnosticsResult(client, uri, {
			timeoutMs: 3000,
			minVersion: 0,
			expectedDocumentVersion: 7,
		});
		await sleep(10);
		await publish(client, uri, "versioned answer", 7);

		const result = await waiting;
		expect(result.diagnostics.map((d) => d.message)).toEqual(["versioned answer"]);
		// A server that versions its publishes must not be slowed down by a window
		// that exists only for servers that do not.
		expect(Date.now() - started).toBeLessThan(80);
	});

	it("returns the last unversioned publish once the stream goes quiet", async () => {
		const client = stubClient();
		const waiting = waitForDiagnosticsResult(client, uri, {
			timeoutMs: 3000,
			minVersion: 0,
			expectedDocumentVersion: 2,
		});
		await sleep(10);
		await publish(client, uri, "first");
		await sleep(20);
		await publish(client, uri, "second");
		await sleep(20);
		await publish(client, uri, "third");

		const result = await waiting;
		expect(result.diagnostics.map((d) => d.message)).toEqual(["third"]);
	});

	it("falls back to the provisional answer when the budget expires mid-settle", async () => {
		const client = stubClient();
		// Budget shorter than the settle window: the publish is all we will ever get,
		// and reporting nothing would mark a productive server as silent.
		const waiting = waitForDiagnosticsResult(client, uri, {
			timeoutMs: 60,
			minVersion: 0,
			expectedDocumentVersion: 2,
		});
		await sleep(5);
		await publish(client, uri, "only answer");

		const result = await waiting;
		expect(result.fresh).toBe(true);
		expect(result.diagnostics.map((d) => d.message)).toEqual(["only answer"]);
	});

	it("keeps reporting nothing fresh when no publish arrives at all", async () => {
		const client = stubClient();
		const result = await waitForDiagnosticsResult(client, uri, {
			timeoutMs: 60,
			minVersion: 0,
			expectedDocumentVersion: 2,
		});
		expect(result.fresh).toBe(false);
		expect(result.diagnostics).toEqual([]);
	});

	it("kill-switch PIT_NO_LSP_DIAG_SETTLE=1 accepts the first unversioned publish again", async () => {
		process.env.PIT_NO_LSP_DIAG_SETTLE = "1";
		try {
			const client = stubClient();
			const waiting = waitForDiagnosticsResult(client, uri, {
				timeoutMs: 3000,
				minVersion: 0,
				expectedDocumentVersion: 2,
			});
			await sleep(10);
			await publish(client, uri, "stale: computed from v1");
			await sleep(40);
			await publish(client, uri, "fresh: computed from v2");

			const result = await waiting;
			// The pre-settle behaviour, stale accept and all.
			expect(result.diagnostics.map((d) => d.message)).toEqual(["stale: computed from v1"]);
		} finally {
			delete process.env.PIT_NO_LSP_DIAG_SETTLE;
		}
	});

	it("honours PIT_LSP_DIAG_SETTLE_MS for tuning the window", async () => {
		process.env.PIT_LSP_DIAG_SETTLE_MS = "300";
		try {
			const client = stubClient();
			const started = Date.now();
			const waiting = waitForDiagnosticsResult(client, uri, {
				timeoutMs: 3000,
				minVersion: 0,
				expectedDocumentVersion: 2,
			});
			await sleep(10);
			await publish(client, uri, "only answer");
			await waiting;
			// Widened window means the answer is held noticeably longer than the 75ms default.
			expect(Date.now() - started).toBeGreaterThan(200);
		} finally {
			delete process.env.PIT_LSP_DIAG_SETTLE_MS;
		}
	});
});

describe("settle window does not leak into the next-publish wait", () => {
	/**
	 * `waitForNextDiagnosticsPublish` backs the cross-file appendix: it must report
	 * whether a NEW publish landed inside its window. Checking already-stored state
	 * on entry — which the settle path needs — would make it return true without any
	 * publish, and the appendix would read the map a beat too early, every time.
	 */
	it("ignores diagnostics that were already published before the wait began", async () => {
		const client = stubClient();
		await publish(client, uri, "published before the wait");
		expect(await waitForNextDiagnosticsPublish(client, 60)).toBe(false);
	});

	it("still reports a publish that lands inside the window", async () => {
		const client = stubClient();
		const waiting = waitForNextDiagnosticsPublish(client, 3000);
		await sleep(10);
		await publish(client, uri, "landed inside");
		expect(await waiting).toBe(true);
	});
});
