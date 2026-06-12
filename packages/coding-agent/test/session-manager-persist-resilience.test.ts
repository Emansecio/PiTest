import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FileEntry, type SessionHeader, SessionManager } from "../src/core/session-manager.js";

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

describe("SessionManager _persist resilience (Fix 1)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-persist-resilience-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
	});

	it("keeps flushed=false and rewrites the FULL batch when the initial append throws", () => {
		const sessionFile = join(tempDir, "session.jsonl");
		const header: SessionHeader = {
			type: "session",
			id: "resilience-session",
			version: 3,
			timestamp: new Date(0).toISOString(),
			cwd: "/tmp",
		};
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf8");

		const mgr = SessionManager.open(sessionFile);

		// Accumulate user history BEFORE the first assistant message. None of these
		// are persisted yet (no assistant message has been seen), so they live only
		// in the initial flush batch.
		mgr.appendMessage({ role: "user", content: "first user line", timestamp: Date.now() });
		mgr.appendMessage({ role: "user", content: "second user line", timestamp: Date.now() });

		// Point the session file at a path inside a non-existent directory so the
		// VERY FIRST flush (header + all accumulated entries) throws ENOENT, exactly
		// like an AV/indexer lock (EBUSY/EPERM) or full disk (ENOSPC) would.
		const brokenFile = join(tempDir, "does-not-exist-dir", "session.jsonl");
		(mgr as unknown as { sessionFile: string }).sessionFile = brokenFile;

		expect(() => mgr.appendMessage(makeAssistantMessage("assistant reply"))).toThrow();

		// After the failed write, flushed must still be false so the next attempt
		// re-emits the complete batch rather than just the delta.
		expect((mgr as unknown as { flushed: boolean }).flushed).toBe(false);

		// Restore a writable path and retry by appending a second assistant message.
		(mgr as unknown as { sessionFile: string }).sessionFile = sessionFile;
		mgr.appendMessage(makeAssistantMessage("assistant reply 2"));

		// The recovered file must contain the FULL history: header + 2 user lines +
		// BOTH assistant messages. If flushed had been left true, the header + user
		// lines + first assistant message would have been permanently lost.
		const entries = readEntries(sessionFile);
		expect(entries[0].type).toBe("session");

		const texts = entries
			.filter((e): e is Extract<FileEntry, { type: "message" }> => e.type === "message")
			.map((e) => {
				const m = e.message as { content: unknown };
				if (typeof m.content === "string") return m.content;
				if (Array.isArray(m.content)) {
					return m.content
						.filter((b: { type?: string }) => b.type === "text")
						.map((b: { text?: string }) => b.text ?? "")
						.join("");
				}
				return "";
			});

		expect(texts).toContain("first user line");
		expect(texts).toContain("second user line");
		expect(texts).toContain("assistant reply");
		expect(texts).toContain("assistant reply 2");
	});

	it("does not lose queued writes when the append throws (queue preserved)", () => {
		const sessionFile = join(tempDir, "queue.jsonl");
		const header: SessionHeader = {
			type: "session",
			id: "queue-session",
			version: 3,
			timestamp: new Date(0).toISOString(),
			cwd: "/tmp",
		};
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf8");

		const mgr = SessionManager.open(sessionFile);
		// Trigger the initial successful flush so subsequent persists take the delta
		// branch (flushed=true).
		mgr.appendMessage(makeAssistantMessage("first"));

		// Seed a pending queued write (simulating an older async code path).
		const queued = `${JSON.stringify({ type: "custom", customType: "queued", id: "q1", parentId: null, timestamp: new Date().toISOString() })}\n`;
		(mgr as unknown as { _writeQueue: string[] })._writeQueue.push(queued);

		// Break the file path so the next append (which must prepend the queue) throws.
		const brokenFile = join(tempDir, "nope-dir", "queue.jsonl");
		(mgr as unknown as { sessionFile: string }).sessionFile = brokenFile;

		expect(() => mgr.appendMessage(makeAssistantMessage("second"))).toThrow();

		// The queued write must survive the failed append (not silently spliced away).
		const queue = (mgr as unknown as { _writeQueue: string[] })._writeQueue;
		expect(queue.length).toBe(1);
		expect(queue[0]).toBe(queued);
	});
});

describe("SessionManager.list size-guard (Fix 2)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sizeguard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
	});

	it("lists an oversized session via bounded head-read without materializing the whole body", async () => {
		const sessionFile = join(tempDir, "2026-01-01T00-00-00-000Z_huge.jsonl");
		const header: SessionHeader = {
			type: "session",
			id: "huge-session",
			version: 3,
			timestamp: new Date(0).toISOString(),
			cwd: "/tmp/huge",
		};
		const userEntry = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: "the first human message" },
		};
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n`, "utf8");

		// Grow the real file past the 8MB full-read ceiling with assistant entries
		// whose text appears only AFTER the bounded head window. If the size-guard
		// failed and the full body were materialized, this marker would leak into
		// allMessagesText.
		const marker = "DEEP_BODY_MARKER_PAST_THE_HEAD_WINDOW";
		const filler = {
			type: "message",
			id: "fill",
			parentId: "m1",
			timestamp: new Date(0).toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: `${marker} ${"x".repeat(2000)}` }] },
		};
		const fillerLine = `${JSON.stringify(filler)}\n`;
		// ~12MB of body → comfortably over the 8MB threshold.
		const targetBytes = 12 * 1024 * 1024;
		let written = statSync(sessionFile).size;
		let chunk = "";
		while (written + chunk.length < targetBytes) {
			chunk += fillerLine;
			if (chunk.length > 256 * 1024) {
				appendFileSync(sessionFile, chunk);
				written += chunk.length;
				chunk = "";
			}
		}
		if (chunk.length > 0) appendFileSync(sessionFile, chunk);

		expect(statSync(sessionFile).size).toBeGreaterThan(8 * 1024 * 1024);

		const sessions = await SessionManager.list("/tmp/huge", tempDir);

		expect(sessions.length).toBe(1);
		const info = sessions[0];
		expect(info.id).toBe("huge-session");
		// Header + first user message come from the bounded head-read.
		expect(info.firstMessage).toBe("the first human message");
		// Body search index is intentionally degraded for huge sessions: the deep
		// marker must NOT be present, proving we never materialized the full body.
		expect(info.allMessagesText).toBe("");
		expect(info.allMessagesText).not.toContain(marker);
	});

	it("reads normal-sized sessions fully (identical behavior, allMessagesText populated)", async () => {
		const sessionFile = join(tempDir, "2026-01-02T00-00-00-000Z_small.jsonl");
		const header: SessionHeader = {
			type: "session",
			id: "small-session",
			version: 3,
			timestamp: new Date(0).toISOString(),
			cwd: "/tmp/small",
		};
		const userEntry = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: "hello small world" },
		};
		const asstEntry = {
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: new Date(0).toISOString(),
			message: makeAssistantMessage("a reply with searchable body"),
		};
		writeFileSync(
			sessionFile,
			`${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n${JSON.stringify(asstEntry)}\n`,
			"utf8",
		);

		const sessions = await SessionManager.list("/tmp/small", tempDir);
		expect(sessions.length).toBe(1);
		const info = sessions[0];
		expect(info.id).toBe("small-session");
		expect(info.firstMessage).toBe("hello small world");
		// Full path: body search index is populated.
		expect(info.allMessagesText).toContain("hello small world");
		expect(info.allMessagesText).toContain("a reply with searchable body");
		expect(info.messageCount).toBe(2);
	});
});
