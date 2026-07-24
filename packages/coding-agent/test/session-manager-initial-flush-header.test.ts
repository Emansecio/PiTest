import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FileEntry, SessionManager } from "../src/core/session-manager.js";

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

function readEntries(path: string): FileEntry[] {
	const content = readFileSync(path, "utf8").trim();
	if (!content) return [];
	return content
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as FileEntry);
}

function countHeaders(path: string): number {
	return readEntries(path).filter((e) => e.type === "session").length;
}

function userTexts(path: string): string[] {
	return readEntries(path)
		.filter((e): e is Extract<FileEntry, { type: "message" }> => e.type === "message")
		.map((e) => {
			const m = e.message as { role?: string; content: unknown };
			const text =
				typeof m.content === "string"
					? m.content
					: Array.isArray(m.content)
						? m.content
								.filter((b: { type?: string }) => b.type === "text")
								.map((b: { text?: string }) => b.text ?? "")
								.join("")
						: "";
			return { role: m.role, text };
		})
		.filter((m) => m.role === "user")
		.map((m) => m.text);
}

describe("H22: initial flush never duplicates a pre-existing header", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-h22-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

	it("empty/corrupt-file recovery: a completed turn writes exactly one header", () => {
		const sessionFile = join(tempDir, "corrupt.jsonl");
		// A corrupt file whose first line is not a valid session header:
		// loadEntriesFromFile returns [] → setSessionFile rewrites a fresh header on
		// disk (flushed=true) with no assistant message yet. This is the crash-recovery
		// path that arms the append-over-existing-header bug.
		writeFileSync(sessionFile, "this is not valid json\n", "utf8");

		const mgr = SessionManager.open(sessionFile);
		expect(countHeaders(sessionFile)).toBe(1); // fresh header written by recovery

		mgr.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		mgr.appendMessage(makeAssistantMessage("hi there"));

		// The initial flush appended the batch. Before the fix it re-appended the
		// header (the batch starts with fileEntries[0], the header already on disk).
		expect(countHeaders(sessionFile)).toBe(1);
		expect(readFileSync(sessionFile, "utf8")).toContain("hi there");
	});

	it("v1 migration of an assistant-less session: no duplicate header AND no duplicated user message", () => {
		const sessionFile = join(tempDir, "v1.jsonl");
		// v1 header (no version) + a bare user entry (no id/parentId), no assistant.
		// Opening migrates v1→v3 → _rewriteFile writes header+user to disk
		// (flushed=true, _hasAssistantMessage=false). The next turn's initial flush
		// re-appended header+user before the fix → header AND user line duplicated.
		const v1Header = { type: "session", id: "v1-sess", timestamp: new Date(0).toISOString(), cwd: "/tmp" };
		const v1User = { type: "message", message: { role: "user", content: "original user line" } };
		writeFileSync(sessionFile, `${JSON.stringify(v1Header)}\n${JSON.stringify(v1User)}\n`, "utf8");

		const mgr = SessionManager.open(sessionFile);
		expect(countHeaders(sessionFile)).toBe(1);

		mgr.appendMessage({ role: "user", content: "second user line", timestamp: Date.now() });
		mgr.appendMessage(makeAssistantMessage("assistant reply"));

		expect(countHeaders(sessionFile)).toBe(1);
		const users = userTexts(sessionFile);
		// The already-persisted user line must appear exactly once.
		expect(users.filter((t) => t === "original user line").length).toBe(1);
		expect(users).toContain("second user line");
		expect(readFileSync(sessionFile, "utf8")).toContain("assistant reply");
	});

	it("brand-new session writes header + turn exactly once (no regression on the create-append path)", () => {
		const mgr = SessionManager.create("/tmp", tempDir);
		const sessionFile = mgr.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");
		mgr.appendMessage({ role: "user", content: "u1", timestamp: Date.now() });
		mgr.appendMessage(makeAssistantMessage("a1"));
		expect(countHeaders(sessionFile)).toBe(1);
		expect(userTexts(sessionFile)).toEqual(["u1"]);
	});
});

describe("H24: persist-failure counting surfaces silent disk/memory divergence", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-h24-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

	it("counts consecutive synchronous initial-flush failures and resets after a success", () => {
		const sessionFile = join(tempDir, "count.jsonl");
		const header = {
			type: "session",
			id: "count-sess",
			version: 3,
			timestamp: new Date(0).toISOString(),
			cwd: "/tmp",
		};
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf8");

		const mgr = SessionManager.open(sessionFile);
		expect(mgr.getConsecutivePersistFailures()).toBe(0);

		mgr.appendMessage({ role: "user", content: "u", timestamp: Date.now() });

		// Point at a path inside a non-existent directory so the initial flush throws
		// ENOENT — same failure shape as a full disk / AV lock the handler swallows.
		(mgr as unknown as { sessionFile: string }).sessionFile = join(tempDir, "nope", "count.jsonl");
		expect(() => mgr.appendMessage(makeAssistantMessage("a"))).toThrow();
		expect(mgr.getConsecutivePersistFailures()).toBe(1);

		expect(() => mgr.appendMessage(makeAssistantMessage("a2"))).toThrow();
		expect(mgr.getConsecutivePersistFailures()).toBe(2);

		// Restore a writable path: the next flush succeeds and resets the counter.
		(mgr as unknown as { sessionFile: string }).sessionFile = sessionFile;
		mgr.appendMessage(makeAssistantMessage("a3"));
		expect(mgr.getConsecutivePersistFailures()).toBe(0);
	});

	it("counts an async delta-drain failure too (post-initial appends)", async () => {
		const sessionFile = join(tempDir, "drain-count.jsonl");
		const header = {
			type: "session",
			id: "drain-sess",
			version: 3,
			timestamp: new Date(0).toISOString(),
			cwd: "/tmp",
		};
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf8");

		const mgr = SessionManager.open(sessionFile);
		(mgr as unknown as { flushed: boolean }).flushed = false;
		mgr.appendMessage(makeAssistantMessage("first")); // synchronous initial flush, succeeds
		expect(mgr.getConsecutivePersistFailures()).toBe(0);

		// Break the path so the async delta drain fails.
		(mgr as unknown as { sessionFile: string }).sessionFile = join(tempDir, "gone", "drain-count.jsonl");
		mgr.appendMessage(makeAssistantMessage("second")); // enqueued + drained async
		await expect(mgr.flushWrites()).rejects.toThrow();
		expect(mgr.getConsecutivePersistFailures()).toBeGreaterThanOrEqual(1);
	});
});
