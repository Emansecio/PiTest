/**
 * Resilience (fault-injection) — PERSISTENCE layer.
 *
 * Scenario 1: while flushing a session batch to disk, `appendFileSync` is
 * bounced by a transient lock (Windows AV/indexer holds the handle → EBUSY).
 * The `appendWithRetry` seam in session-manager must (a) retry with backoff
 * until the write lands so the full batch (header + all entries) is durable and
 * NOTHING is lost, and (b) surface each bounce on the observable
 * `runtime-diagnostics` channel as `io.retry` so an autonomous run (goal /
 * coordinator / RPC headless — no stderr, no ESC) can still see the lock churn.
 *
 * Anti-flaky: the `fs` module is mocked (same controllable seam the existing
 * session-manager-durability test uses) so EBUSY is injected synchronously by a
 * counter — no real lock, no real AV. The retry's internal backoff is a bounded
 * `Atomics.wait` of a few ms inside the SUT; the test itself never sleeps,
 * polls, or schedules a timer, and the whole file resolves synchronously per
 * `appendMessage`. Determinism comes from the failure counter, not wall time.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHeader } from "../../src/core/session-manager.js";

// Controllable fs mock — mirrors session-manager-durability.test.ts. The SUT
// imports `appendFileSync` from the bare "fs" specifier, so this interception
// binds. A counter arms N transient EBUSY failures, then everything passes
// through to the real fs. Defaults = passthrough.
let appendFailuresRemaining = 0;
let appendFailureCode = "EBUSY";
let appendAttempts = 0;

function fsError(code: string): Error & { code: string } {
	const err = new Error(`mock append ${code}`) as Error & { code: string };
	err.code = code;
	return err;
}

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs");
	return {
		...actual,
		appendFileSync: (path: string, data: string) => {
			appendAttempts++;
			if (appendFailuresRemaining > 0) {
				appendFailuresRemaining--;
				throw fsError(appendFailureCode);
			}
			return actual.appendFileSync(path, data);
		},
	};
});

// Import the SUT AFTER vi.mock so it binds the mocked fs. Pull the real fs for
// the test's own setup/teardown so we are not subject to the injected failures.
const { SessionManager } = await import("../../src/core/session-manager.js");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await vi.importActual<typeof import("fs")>("fs");

function makeAssistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-completions" as const,
		provider: "openai",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function header(id: string, cwd: string): SessionHeader {
	return { type: "session", id, version: 3, timestamp: new Date(0).toISOString(), cwd };
}

describe("resilience: appendFileSync EBUSY → retry absorbs the lock → no history loss + observable", () => {
	let tempDir: string;

	beforeEach(() => {
		resetRuntimeDiagnostics();
		appendFailuresRemaining = 0;
		appendFailureCode = "EBUSY";
		appendAttempts = 0;
		tempDir = join(tmpdir(), `pi-resilience-ebusy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore Windows handle race */
			}
		}
		// 60s teardown budget: rmSync of a temp dir under full-suite contention on
		// Windows can briefly exceed the 10s default while a handle is released.
	}, 60_000);

	it("(1) EBUSY twice then success: the complete batch (header + entries) lands and io.retry is recorded", () => {
		const sessionFile = join(tempDir, "ebusy.jsonl");
		writeFileSync(sessionFile, `${JSON.stringify(header("res-ebusy", "/tmp"))}\n`, "utf8");

		const mgr = SessionManager.open(sessionFile);
		mgr.appendMessage({ role: "user", content: "durable user line", timestamp: Date.now() });

		// The next real flush (header + user + assistant batch) hits 2 transient
		// EBUSY failures before succeeding on the 3rd attempt.
		appendFailuresRemaining = 2;
		appendFailureCode = "EBUSY";

		// (a-recovery) the write eventually completes — the retry absorbs the lock.
		expect(() => mgr.appendMessage(makeAssistantMessage("durable assistant reply"))).not.toThrow();
		// 2 failed attempts + 1 success on the same batch.
		expect(appendAttempts).toBe(3);

		// (a) no history loss: the FULL batch is durable on disk, header included.
		const content = readFileSync(sessionFile, "utf8");
		expect(content).toContain("res-ebusy"); // header survived
		expect(content).toContain("durable user line");
		expect(content).toContain("durable assistant reply");
		// The file is well-formed JSONL: every non-empty line parses.
		const lines = content.trim().split("\n");
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}

		// (b) the fault is observable on the runtime-diagnostics channel.
		const snap = getRuntimeDiagnostics();
		expect(snap.counters["io.retry"]?.count ?? 0).toBeGreaterThanOrEqual(1);
		// Two bounces were recorded (one per absorbed failure), each a warn.
		expect(snap.counters["io.retry"]?.count).toBe(2);
		expect(snap.counters["io.retry"]?.level).toBe("warn");
		// The recorded context carries the path + attempt + the EBUSY code for a
		// /diagnostics one-liner, and lands in the inspectable recent ring.
		expect(snap.counters["io.retry"]?.lastContext?.path).toBe(sessionFile);
		expect(snap.counters["io.retry"]?.lastContext?.note).toBe("EBUSY");
		const retryEvents = snap.recent.filter((e) => e.category === "io.retry");
		expect(retryEvents.length).toBe(2);
		expect(retryEvents.map((e) => e.context?.attempt)).toEqual([1, 2]);
	});

	it("(1b) a clean flush (no lock) loses nothing and records ZERO io.retry", () => {
		const sessionFile = join(tempDir, "clean.jsonl");
		writeFileSync(sessionFile, `${JSON.stringify(header("res-clean", "/tmp"))}\n`, "utf8");

		const mgr = SessionManager.open(sessionFile);
		mgr.appendMessage({ role: "user", content: "clean user line", timestamp: Date.now() });
		// No failures armed → a single successful attempt for the batch.
		expect(() => mgr.appendMessage(makeAssistantMessage("clean assistant reply"))).not.toThrow();

		const content = readFileSync(sessionFile, "utf8");
		expect(content).toContain("clean user line");
		expect(content).toContain("clean assistant reply");
		// The happy path must not pollute the diagnostics channel.
		expect(getRuntimeDiagnostics().counters["io.retry"]?.count ?? 0).toBe(0);
	});
});
