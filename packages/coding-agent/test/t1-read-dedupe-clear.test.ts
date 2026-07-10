/**
 * C9 / T09: Read-dedupe is not wiped on compaction. With empty summary file
 * lists, prune is a no-op (entries survive). With a keep-set, orphan paths are
 * pruned; summary-anchored paths remain for re-read suppression.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CompactionController,
	executeCompactionPipeline,
	pruneReadDedupeAfterCompaction,
} from "../src/core/agent-session-compaction.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.js";
import { createFileOps } from "../src/core/compaction/utils.js";
import { SessionManager } from "../src/core/session-manager.js";
import { canonicalPathKey } from "../src/core/tools/path-utils.js";
import { createReadTool, pathFromDedupeKey, ReadDedupeStore } from "../src/core/tools/read.js";

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
	return res.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

function stubPreparation(firstKeptEntryId = "entry-0") {
	return {
		firstKeptEntryId,
		messagesToSummarize: [],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 100,
		fileOps: createFileOps(),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}

function makeCompactionCtx(store: ReadDedupeStore, sessionManager: SessionManager): CompactionController {
	const host = {
		sessionId: "c9-read-dedupe",
		readDedupeStore: store,
		thinkingLevel: "off" as const,
		extensionRunner: {
			hasHandlers: (type: string) => type === "session_before_compact",
			emit: async () => ({
				compaction: {
					summary: "compacted summary",
					firstKeptEntryId: sessionManager.getBranch()[0]?.id ?? "entry-0",
					tokensBefore: 100,
					details: {},
				},
			}),
		},
		sessionManager,
		agent: { state: { messages: [] } },
		hindsightBank: undefined,
	};
	return new CompactionController(host as unknown as CompactionController["host"]);
}

describe("C9: read-dedupe survives compaction", () => {
	it("executeCompactionPipeline does not clear ReadDedupeStore", async () => {
		const store = new ReadDedupeStore();
		const key = "src/a.ts  ";
		expect(store.record(key, "h1", "body", true)).toBe(false);
		expect(store.record(key, "h1", "body", true)).toBe(true);

		const sessionManager = SessionManager.inMemory();
		const ctx = makeCompactionCtx(store, sessionManager);

		await executeCompactionPipeline(ctx, {
			preparation: stubPreparation(),
			pathEntries: sessionManager.getBranch(),
			model: {} as never,
			apiKey: "key",
			headers: {},
			abortSignal: new AbortController().signal,
		});

		expect(store.peek(key)).toBeDefined();
		expect(store.record(key, "h1", "body", true)).toBe(true);
	});

	it("re-read of unchanged path still dedupes after compaction pipeline", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pit-c9-read-dedupe-"));
		try {
			const file = join(dir, "sample.ts");
			writeFileSync(file, "export const value = 1;\n");

			const store = new ReadDedupeStore();
			const tool = createReadTool(dir, { embedHashlineAnchors: false, readDedupeStore: store });

			const first = textOf(await tool.execute("1", { path: file }));
			expect(first).toContain("value = 1");
			expect(first).not.toContain("identical to an earlier read");

			const sessionManager = SessionManager.inMemory();
			const ctx = makeCompactionCtx(store, sessionManager);
			await executeCompactionPipeline(ctx, {
				preparation: stubPreparation(),
				pathEntries: sessionManager.getBranch(),
				model: {} as never,
				apiKey: "key",
				headers: {},
				abortSignal: new AbortController().signal,
			});

			const second = textOf(await tool.execute("2", { path: file }));
			expect(second).toContain("identical to an earlier read this session");
			expect(second).not.toContain("value = 1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("clear() still resets dedupe when invoked explicitly", () => {
		const store = new ReadDedupeStore();
		const key = "b.ts  ";
		expect(store.record(key, "h1", "original", true)).toBe(false);
		expect(store.peek(key)).toBeDefined();
		store.clear();
		expect(store.peek(key)).toBeUndefined();
		expect(store.record(key, "h1", "original", true)).toBe(false);
	});
});

describe("T09: selective read-dedupe prune after compaction", () => {
	it("pathFromDedupeKey strips the range suffix", () => {
		expect(pathFromDedupeKey("C:/repo/a.ts  ")).toBe("C:/repo/a.ts");
		expect(pathFromDedupeKey("C:/repo/a.ts 10 20")).toBe("C:/repo/a.ts");
	});

	it("pruneExcept drops paths outside the keep-set and keeps summary paths", () => {
		const store = new ReadDedupeStore();
		const keepPath = canonicalPathKey("/repo/keep.ts");
		const dropPath = canonicalPathKey("/repo/drop.ts");
		const keepKey = `${keepPath}  `;
		const dropKey = `${dropPath}  `;
		store.record(keepKey, "h1", "keep-body", true);
		store.record(dropKey, "h2", "drop-body", true);

		store.pruneExcept(new Set([keepPath]));

		expect(store.peek(keepKey)).toBeDefined();
		expect(store.peek(dropKey)).toBeUndefined();
	});

	it("pruneReadDedupeAfterCompaction no-ops when details have no file lists", () => {
		const store = new ReadDedupeStore();
		const key = `${canonicalPathKey("/repo/a.ts")}  `;
		store.record(key, "h1", "body", true);
		const ctx = makeCompactionCtx(store, SessionManager.inMemory());
		pruneReadDedupeAfterCompaction(ctx, {});
		expect(store.peek(key)).toBeDefined();
	});

	it("pruneReadDedupeAfterCompaction keeps summary paths and drops others", () => {
		const dir = mkdtempSync(join(tmpdir(), "pit-t09-dedupe-"));
		try {
			const keepFile = join(dir, "keep.ts");
			const dropFile = join(dir, "drop.ts");
			writeFileSync(keepFile, "export const keep = 1;\n");
			writeFileSync(dropFile, "export const drop = 1;\n");

			const store = new ReadDedupeStore();
			const keepKey = `${canonicalPathKey(keepFile)}  `;
			const dropKey = `${canonicalPathKey(dropFile)}  `;
			store.record(keepKey, "h1", "keep", true);
			store.record(dropKey, "h2", "drop", true);

			const host = {
				sessionId: "t09",
				readDedupeStore: store,
				cwd: dir,
				fileMtimeStore: undefined,
			};
			const ctx = new CompactionController(host as unknown as CompactionController["host"]);
			pruneReadDedupeAfterCompaction(ctx, { readFiles: ["keep.ts"], modifiedFiles: [] });

			expect(store.peek(keepKey)).toBeDefined();
			expect(store.peek(dropKey)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
