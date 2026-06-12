import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHeader } from "../src/core/session-manager.js";

// Controllable fs mock. The SUT imports from "fs"; we wrap appendFileSync,
// renameSync and writeFileSync with counters so individual tests can arm
// transient failures (EBUSY/EPERM) or a crash on demand while everything else
// stays real. Defaults = passthrough.
let appendFailuresRemaining = 0;
let appendFailureCode = "EBUSY";
let appendAttempts = 0;
let renameFailuresRemaining = 0;
let renameFailureCode = "EBUSY";
let writeFailuresRemaining = 0;
let writeFailureCode = "EIO";

function fsError(code: string, label: string): Error & { code: string } {
	const err = new Error(`mock ${label} ${code}`) as Error & { code: string };
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
				throw fsError(appendFailureCode, "append");
			}
			return actual.appendFileSync(path, data);
		},
		renameSync: (from: string, to: string) => {
			if (renameFailuresRemaining > 0) {
				renameFailuresRemaining--;
				throw fsError(renameFailureCode, "rename");
			}
			return actual.renameSync(from, to);
		},
		writeFileSync: (path: string, data: string) => {
			if (writeFailuresRemaining > 0) {
				writeFailuresRemaining--;
				throw fsError(writeFailureCode, "write");
			}
			return actual.writeFileSync(path, data);
		},
	};
});

// Import the SUT AFTER vi.mock so it binds the mocked fs.
const { SessionManager } = await import("../src/core/session-manager.js");

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

function tmpFiles(dir: string): string[] {
	return readdirSync(dir).filter((f) => f.includes(".tmp-"));
}

beforeEach(() => {
	appendFailuresRemaining = 0;
	appendFailureCode = "EBUSY";
	appendAttempts = 0;
	renameFailuresRemaining = 0;
	renameFailureCode = "EBUSY";
	writeFailuresRemaining = 0;
	writeFailureCode = "EIO";
});

describe("B7: atomic full-file rewrite (_rewriteFile / createBranchedSession)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-durability-b7-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore Windows handle race */
			}
		}
	});

	it("writes the complete file and leaves NO temp file behind on a normal rewrite", () => {
		// v1 header (no version) forces a migration → _rewriteFile on open.
		const sessionFile = join(tempDir, "migrate.jsonl");
		const v1Header = { type: "session", id: "b7-migrate", timestamp: new Date(0).toISOString(), cwd: "/tmp" };
		const msg = {
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: "hello world" },
		};
		writeFileSync(sessionFile, `${JSON.stringify(v1Header)}\n${JSON.stringify(msg)}\n`, "utf8");

		SessionManager.open(sessionFile);

		// File intact and parseable; header upgraded to current version.
		const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
		const parsedHeader = JSON.parse(lines[0]);
		expect(parsedHeader.type).toBe("session");
		expect(parsedHeader.version).toBe(3);
		// Atomic write must clean up its sibling temp file.
		expect(tmpFiles(tempDir)).toEqual([]);
	});

	it("a crash during the temp write does NOT truncate the destination (in-place rewrite) and cleans the temp", () => {
		// v1 header → opening triggers an in-place _rewriteFile of the SAME file.
		// Arm a crash on the temp write so the rewrite throws BEFORE any rename.
		const sessionFile = join(tempDir, "crash-temp.jsonl");
		const v1Header = { type: "session", id: "b7-crash", timestamp: new Date(0).toISOString(), cwd: "/tmp" };
		const msg = {
			type: "message",
			id: "keep",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: makeAssistantMessage("original durable content"),
		};
		const original = `${JSON.stringify(v1Header)}\n${JSON.stringify(msg)}\n`;
		writeFileSync(sessionFile, original, "utf8");

		// writeFileAtomic writes the temp first, then renames — failing the temp
		// write models a crash before the rename ever happens, so the destination
		// (the original file) must be left byte-for-byte intact.
		writeFailuresRemaining = 1;
		writeFailureCode = "EIO";
		expect(() => SessionManager.open(sessionFile)).toThrow();

		// Destination still holds the ORIGINAL (un-migrated) content, not truncated.
		const after = readFileSync(sessionFile, "utf8");
		expect(after).toBe(original);
		expect(after.length).toBeGreaterThan(0);
		// No orphan temp file.
		expect(tmpFiles(tempDir)).toEqual([]);
	});

	it("falls back to a direct write when rename keeps failing (still persists)", () => {
		const sessionFile = join(tempDir, "rename-fail.jsonl");
		const v1Header = { type: "session", id: "b7-rename", timestamp: new Date(0).toISOString(), cwd: "/tmp" };
		const msg = {
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: "needs migration" },
		};
		writeFileSync(sessionFile, `${JSON.stringify(v1Header)}\n${JSON.stringify(msg)}\n`, "utf8");

		// Rename throws EPERM on every attempt → writeFileAtomic falls back to a
		// direct writeFileSync. All 3 backoff attempts consume one failure each.
		renameFailuresRemaining = 10;
		renameFailureCode = "EPERM";

		SessionManager.open(sessionFile);

		const parsedHeader = JSON.parse(readFileSync(sessionFile, "utf8").trim().split("\n")[0]);
		expect(parsedHeader.version).toBe(3);
		// Fallback path also cleans the temp file.
		expect(tmpFiles(tempDir)).toEqual([]);
	});
});

describe("FU2: appendWithRetry absorbs transient EBUSY/EPERM in _persist", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-durability-fu2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore Windows handle race */
			}
		}
	});

	it("succeeds when the append throws EBUSY twice then completes (retry absorbs the lock)", () => {
		const sessionFile = join(tempDir, "ebusy.jsonl");
		writeFileSync(sessionFile, `${JSON.stringify(header("fu2-ebusy", "/tmp"))}\n`, "utf8");

		const mgr = SessionManager.open(sessionFile);
		mgr.appendMessage({ role: "user", content: "before flush", timestamp: Date.now() });

		// The FIRST real append (initial flush: header + user + assistant) hits 2
		// transient EBUSY failures before succeeding on the 3rd attempt.
		appendFailuresRemaining = 2;
		appendFailureCode = "EBUSY";

		expect(() => mgr.appendMessage(makeAssistantMessage("assistant reply"))).not.toThrow();
		// 2 failed attempts + 1 success.
		expect(appendAttempts).toBe(3);

		// The write completed: full history is durable on disk.
		const content = readFileSync(sessionFile, "utf8");
		expect(content).toContain("before flush");
		expect(content).toContain("assistant reply");
	});

	it("propagates after exhausting retries (3 EPERM) and keeps flushed=false for the next attempt", () => {
		const sessionFile = join(tempDir, "ebusy-exhaust.jsonl");
		writeFileSync(sessionFile, `${JSON.stringify(header("fu2-exhaust", "/tmp"))}\n`, "utf8");

		const mgr = SessionManager.open(sessionFile);
		mgr.appendMessage({ role: "user", content: "user line", timestamp: Date.now() });

		// More failures than the retry budget (3) → the error must propagate.
		appendFailuresRemaining = 5;
		appendFailureCode = "EPERM";

		expect(() => mgr.appendMessage(makeAssistantMessage("never lands"))).toThrow();
		// Exactly the retry budget was consumed.
		expect(appendAttempts).toBe(3);
		// flushed stays false so the next attempt re-emits the full batch (A6 invariant).
		expect((mgr as unknown as { flushed: boolean }).flushed).toBe(false);

		// Now let the append succeed and confirm the full batch is recovered.
		appendFailuresRemaining = 0;
		mgr.appendMessage(makeAssistantMessage("recovered"));
		const content = readFileSync(sessionFile, "utf8");
		expect(content).toContain("user line");
		expect(content).toContain("recovered");
	});

	it("does NOT retry on a hard error (ENOSPC) — propagates immediately", () => {
		const sessionFile = join(tempDir, "enospc.jsonl");
		writeFileSync(sessionFile, `${JSON.stringify(header("fu2-enospc", "/tmp"))}\n`, "utf8");

		const mgr = SessionManager.open(sessionFile);
		mgr.appendMessage({ role: "user", content: "user line", timestamp: Date.now() });

		appendFailuresRemaining = 5;
		appendFailureCode = "ENOSPC";

		expect(() => mgr.appendMessage(makeAssistantMessage("no space"))).toThrow();
		// Hard error → single attempt, no retry loop.
		expect(appendAttempts).toBe(1);
	});
});
