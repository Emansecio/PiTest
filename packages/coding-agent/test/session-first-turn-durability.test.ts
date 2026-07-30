/**
 * The user's prompt reaches disk before the answer does.
 *
 * The session file is created lazily, on the first entry worth keeping, and
 * anything appended before that is held in memory and written retroactively in
 * the same initial flush. So the predicate deciding "worth keeping" is really
 * deciding how much a crash can cost.
 *
 * It used to be "an assistant message", which sounds equivalent to "a turn
 * happened" and is not: the assistant entry is persisted at message_end, so the
 * window covered the ENTIRE turn. Anything that killed the process during a long
 * turn — OOM, closed lid, a `kill`, a Windows update — took the prompt with it,
 * and the prompt is the one thing in a session the user typed by hand.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FileEntry, SessionManager } from "../src/core/session-manager.js";

let tempDir: string;

beforeEach(() => {
	tempDir = join(tmpdir(), `pit-first-turn-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
});

afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

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
	return content.split("\n").map((l) => JSON.parse(l) as FileEntry);
}

function userTexts(path: string): string[] {
	return readEntries(path)
		.filter((e) => e.type === "message" && (e as { message: { role: string } }).message.role === "user")
		.map((e) => String((e as unknown as { message: { content: string } }).message.content));
}

describe("first-turn durability", () => {
	it("persists the user's prompt without waiting for the assistant", () => {
		const mgr = SessionManager.create("/tmp", tempDir);
		const file = mgr.getSessionFile();
		if (!file) throw new Error("expected a session file");

		mgr.appendMessage({ role: "user", content: "the prompt I typed", timestamp: Date.now() });

		// Simulating the crash: nothing else runs. The file must already hold it.
		expect(existsSync(file)).toBe(true);
		expect(userTexts(file)).toEqual(["the prompt I typed"]);
	});

	it("writes header + prompt exactly once when the answer does arrive", async () => {
		const mgr = SessionManager.create("/tmp", tempDir);
		const file = mgr.getSessionFile();
		if (!file) throw new Error("expected a session file");

		mgr.appendMessage({ role: "user", content: "u1", timestamp: Date.now() });
		mgr.appendMessage(makeAssistantMessage("a1"));
		// The answer rides the async drain (the prompt already took the synchronous
		// initial flush), which turn/dispose boundaries settle via flushWrites.
		await mgr.flushWrites();

		const entries = readEntries(file);
		expect(entries.filter((e) => e.type === "session")).toHaveLength(1);
		expect(userTexts(file)).toEqual(["u1"]);
		expect(readFileSync(file, "utf8")).toContain("a1");
	});

	it("the answer is not double-written when it follows queued deltas", async () => {
		const mgr = SessionManager.create("/tmp", tempDir);
		const file = mgr.getSessionFile();
		if (!file) throw new Error("expected a session file");

		mgr.appendMessage({ role: "user", content: "u1", timestamp: Date.now() });
		mgr.appendThinkingLevelChange("high"); // lands on the async queue
		mgr.appendMessage(makeAssistantMessage("a1"));
		await mgr.flushWrites();

		const ids = readEntries(file)
			.filter((e) => e.type !== "session")
			.map((e) => (e as { id?: string }).id)
			.filter((id): id is string => typeof id === "string");
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("bookkeeping alone still creates nothing — an empty shell is not a session", () => {
		const mgr = SessionManager.create("/tmp", tempDir);
		const file = mgr.getSessionFile();
		if (!file) throw new Error("expected a session file");

		mgr.appendThinkingLevelChange("high");

		expect(existsSync(file)).toBe(false);
	});

	it("a bookkeeping entry before the prompt rides along on the same flush", () => {
		const mgr = SessionManager.create("/tmp", tempDir);
		const file = mgr.getSessionFile();
		if (!file) throw new Error("expected a session file");

		mgr.appendThinkingLevelChange("high");
		mgr.appendMessage({ role: "user", content: "u1", timestamp: Date.now() });

		const types = readEntries(file).map((e) => e.type);
		expect(types).toContain("thinking_level_change");
		expect(types).toContain("message");
		expect(types.filter((t) => t === "session")).toHaveLength(1);
	});
});
