import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FileEntry, type SessionHeader, SessionManager } from "../src/core/session-manager.js";

// Instrument the async append path so the test can observe overlap: a correct
// guard keeps at most ONE appendFile in flight against the same session file.
// vi.mock is hoisted above the imports, so session-manager binds this mock.
let inFlight = 0;
let maxInFlight = 0;
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>();
	return {
		...actual,
		appendFile: vi.fn(async (...args: Parameters<typeof actual.appendFile>) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			// Yield a macrotask to widen the overlap window: if a second drain
			// generation could start concurrently, it would do so here.
			await new Promise((r) => setTimeout(r, 1));
			try {
				return await actual.appendFile(...args);
			} finally {
				inFlight--;
			}
		}),
	};
});

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

function extractText(entry: FileEntry): string {
	if (entry.type !== "message") return "";
	const m = entry.message as { content: unknown };
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		return m.content
			.filter((b: { type?: string }) => b.type === "text")
			.map((b: { text?: string }) => b.text ?? "")
			.join("");
	}
	return "";
}

describe("SessionManager _drainQueue serialization invariant", () => {
	let tempDir: string;

	beforeEach(() => {
		inFlight = 0;
		maxInFlight = 0;
		tempDir = join(tmpdir(), `pi-drain-serial-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

	it("never runs two appendFile calls concurrently under interleaved flush/append stress", async () => {
		const sessionFile = join(tempDir, "drain.jsonl");
		const header: SessionHeader = {
			type: "session",
			id: "drain-serial-session",
			version: 3,
			timestamp: new Date(0).toISOString(),
			cwd: "/tmp",
		};
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf8");

		const mgr = SessionManager.open(sessionFile);
		// open() marks flushed=true for a header-only file; force the first assistant
		// message through the synchronous initial-flush path so every LATER append
		// routes through the async delta queue + _drainQueue (the code under test).
		(mgr as unknown as { flushed: boolean }).flushed = false;
		mgr.appendMessage(makeAssistantMessage("init"));

		const expected = new Set<string>();
		const chainPromises: Promise<void>[] = [];
		const total = 50;
		for (let i = 0; i < total; i++) {
			const tag = `m${i}`;
			mgr.appendMessage(makeAssistantMessage(tag));
			expected.add(tag);

			// Race a manual flush against the timer-driven drain.
			if (i % 5 === 0) void mgr.flushWrites();

			// Chained caller pattern: append fired from inside a settled flush — the
			// exact interleaving the one-shot guard did not provably serialize.
			if (i % 7 === 0) {
				const ctag = `c${i}`;
				expected.add(ctag);
				chainPromises.push(
					mgr.flushWrites().then(() => {
						mgr.appendMessage(makeAssistantMessage(ctag));
					}),
				);
			}

			// Vary the macrotask boundaries so drains settle at different points.
			if (i % 3 === 0) await new Promise((r) => setTimeout(r, 0));
		}

		await Promise.all(chainPromises);
		await mgr.flushWrites();

		// Primary invariant: the fix makes single-appender serialization provable.
		expect(maxInFlight).toBe(1);
		// Guard against a vacuous pass — the async path must actually have run.
		expect(inFlight).toBe(0);

		const entries = readEntries(sessionFile); // throws if any line is not valid JSON
		const texts = entries.map(extractText).filter((t) => /^[mc]\d+$/.test(t));

		// No duplicates and no drops: exactly the set we appended, once each.
		expect(texts.length).toBe(expected.size);
		expect(new Set(texts).size).toBe(texts.length);
		expect(new Set(texts)).toEqual(expected);

		// FIFO within the synchronously-appended m-series: order preserved.
		const mSeries = texts.filter((t) => /^m\d+$/.test(t));
		const expectedM = Array.from({ length: total }, (_, i) => `m${i}`);
		expect(mSeries).toEqual(expectedM);
	});
});
