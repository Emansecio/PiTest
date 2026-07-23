/**
 * Unit coverage for the graph-prefetch extension (P6): a fake ExtensionAPI
 * captures `tool_result` / `turn_start` / `tool_execution_start` /
 * `tool_execution_end`, `getLivingRepoMap` is mocked (same technique as
 * `impact-extension.test.ts`), and an injected `readFileSnapshot` stands in
 * for the real filesystem so warming never touches disk.
 *
 * `tool_result`'s handler kicks off warming fire-and-forget (never awaited),
 * so every test that expects a warm effect must flush the microtask queue
 * after firing the event — see `flush()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getLivingRepoMap = vi.fn();

vi.mock("../src/core/repo-map/living-index.ts", () => ({
	getLivingRepoMap: (...args: unknown[]) => getLivingRepoMap(...args),
}));

import { createGraphPrefetchExtension, type FileReadSnapshot } from "../src/core/built-ins/graph-prefetch-extension.ts";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";
import { resolveToolPath } from "../src/core/tools/argument-prep.ts";
import { WarmFileCache } from "../src/core/tools/warm-file-cache.ts";

const CWD = process.cwd();

type Handler = (event: any) => unknown;

function makeFakePi() {
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	const fire = (event: string, payload?: unknown): unknown => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) {
			const r = handler(payload);
			if (r !== undefined && result === undefined) result = r;
		}
		return result;
	};
	return { api: api as unknown as ExtensionAPI, fire };
}

/** Flush enough microtask ticks for the fire-and-forget warm chain (graph fetch + N candidate reads) to settle. */
async function flush(): Promise<void> {
	for (let i = 0; i < 40; i++) await Promise.resolve();
}

function entry(path: string, deps?: string[]): Record<string, unknown> {
	return { path, symbols: ["x"], mtimeMs: 1, ...(deps ? { deps } : {}) };
}

function mockMap(entries: Array<Record<string, unknown>>): void {
	getLivingRepoMap.mockResolvedValue({
		map: { version: 4, lastIndexedCommit: "abc", entries },
		mode: "cache-hit",
		reindexedCount: 0,
	});
}

function toolResult(toolName: string, input: Record<string, unknown>, text = "ok"): Record<string, unknown> {
	return {
		type: "tool_result",
		toolCallId: "c1",
		toolName,
		input,
		content: [{ type: "text", text }],
		details: undefined,
		isError: false,
	};
}

function findSymbolResult(hits: string[]): Record<string, unknown> {
	const text = hits.length > 0 ? `foo declared at:\n${hits.join("\n")}` : `No declaration of "foo" found.`;
	return toolResult("find_symbol", { name: "foo" }, text);
}

/** Absolute path the extension resolves a repo-relative candidate to — same helper both sides use. */
function abs(relPath: string): string {
	return resolveToolPath(relPath, CWD);
}

function makeSnapshotReader(bodies: Record<string, string>) {
	const reads: string[] = [];
	const readFileSnapshot = async (absPath: string): Promise<FileReadSnapshot | undefined> => {
		reads.push(absPath);
		const content = bodies[absPath];
		if (content === undefined) return undefined;
		return { content, mtimeMs: 1000, size: content.length };
	};
	return { readFileSnapshot, reads };
}

describe("createGraphPrefetchExtension", () => {
	beforeEach(() => {
		getLivingRepoMap.mockReset();
	});
	afterEach(() => {
		delete process.env.PIT_NO_GRAPH_PREFETCH;
	});

	it("warms grade-1 dependents of a read file into the cache", async () => {
		mockMap([entry("src/seed.ts"), entry("src/a.ts", ["src/seed.ts"]), entry("src/b.ts", ["src/seed.ts"])]);
		const cache = new WarmFileCache();
		const { readFileSnapshot } = makeSnapshotReader({
			[abs("src/a.ts")]: "content a",
			[abs("src/b.ts")]: "content b",
		});
		const { api, fire } = makeFakePi();
		createGraphPrefetchExtension({ cwd: CWD, getWarmFileCache: () => cache, readFileSnapshot })(api);

		fire("tool_result", toolResult("read", { path: "src/seed.ts" }));
		await flush();

		expect(cache.peek(abs("src/a.ts"))?.content).toBe("content a");
		expect(cache.peek(abs("src/b.ts"))?.content).toBe("content b");
	});

	it("warms the same way from a symbol tool result", async () => {
		mockMap([entry("src/seed.ts"), entry("src/a.ts", ["src/seed.ts"])]);
		const cache = new WarmFileCache();
		const { readFileSnapshot } = makeSnapshotReader({ [abs("src/a.ts")]: "content a" });
		const { api, fire } = makeFakePi();
		createGraphPrefetchExtension({ cwd: CWD, getWarmFileCache: () => cache, readFileSnapshot })(api);

		fire("tool_result", toolResult("symbol", { path: "src/seed.ts", name: "foo" }));
		await flush();

		expect(cache.peek(abs("src/a.ts"))?.content).toBe("content a");
	});

	it("seeds from find_symbol's own 'path:line' hit lines, capped and deduped", async () => {
		mockMap([entry("src/hit1.ts"), entry("src/hit2.ts"), entry("src/dep.ts", ["src/hit1.ts"])]);
		const cache = new WarmFileCache();
		const { readFileSnapshot } = makeSnapshotReader({ [abs("src/dep.ts")]: "dep content" });
		const { api, fire } = makeFakePi();
		createGraphPrefetchExtension({ cwd: CWD, getWarmFileCache: () => cache, readFileSnapshot })(api);

		fire("tool_result", findSymbolResult(["src/hit1.ts:10", "src/hit1.ts:10", "src/hit2.ts:3"]));
		await flush();

		expect(cache.peek(abs("src/dep.ts"))?.content).toBe("dep content");
	});

	it("does not seed anything from a find_symbol 'not found' result", async () => {
		mockMap([entry("src/dep.ts")]);
		const cache = new WarmFileCache();
		const { readFileSnapshot, reads } = makeSnapshotReader({});
		const { api, fire } = makeFakePi();
		createGraphPrefetchExtension({ cwd: CWD, getWarmFileCache: () => cache, readFileSnapshot })(api);

		fire("tool_result", findSymbolResult([]));
		await flush();

		expect(reads).toEqual([]);
	});

	it("prioritizes dependentsOf > dependenciesOf > testsCovering", async () => {
		mockMap([
			entry("src/seed.ts", ["src/imported.ts"]),
			entry("src/imported.ts"),
			entry("src/dependent.ts", ["src/seed.ts"]),
			entry("test/seed.test.ts", ["src/seed.ts"]),
		]);
		const cache = new WarmFileCache();
		const { readFileSnapshot, reads } = makeSnapshotReader({
			[abs("src/dependent.ts")]: "d",
			[abs("src/imported.ts")]: "i",
			[abs("test/seed.test.ts")]: "t",
		});
		const { api, fire } = makeFakePi();
		createGraphPrefetchExtension({ cwd: CWD, getWarmFileCache: () => cache, readFileSnapshot })(api);

		fire("tool_result", toolResult("read", { path: "src/seed.ts" }));
		await flush();

		// dependentsOf(seed) = [src/dependent.ts, test/seed.test.ts] (sorted),
		// then dependenciesOf(seed) = [src/imported.ts]. testsCovering(seed) is a
		// filter OVER dependentsOf(seed), so it contributes nothing new here —
		// the observable order is exactly dependents (both of them) then deps.
		expect(reads).toEqual([abs("src/dependent.ts"), abs("test/seed.test.ts"), abs("src/imported.ts")]);
	});

	it("caps warming at the shared per-turn budget and resets it on turn_start", async () => {
		const deps = Array.from({ length: 20 }, (_, i) => `src/dep${i}.ts`);
		mockMap([entry("src/seed.ts"), ...deps.map((p) => entry(p, ["src/seed.ts"]))]);
		const cache = new WarmFileCache();
		const bodies: Record<string, string> = {};
		for (const p of deps) bodies[abs(p)] = `body of ${p}`;
		const { readFileSnapshot, reads } = makeSnapshotReader(bodies);
		const { api, fire } = makeFakePi();
		createGraphPrefetchExtension({ cwd: CWD, getWarmFileCache: () => cache, readFileSnapshot })(api);

		fire("tool_result", toolResult("read", { path: "src/seed.ts" }));
		await flush();
		expect(reads).toHaveLength(12); // NEIGHBOR_BUDGET_PER_TURN — 8 of the 20 dependents stay cold this turn

		reads.length = 0;
		fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
		fire("tool_result", toolResult("read", { path: "src/seed.ts" }));
		await flush();
		// The first 12 are already warm (a free cache.has() skip, no budget spent),
		// so the refilled budget goes entirely to the 8 that were left cold.
		expect(reads).toHaveLength(8);
		expect(cache.size).toBe(20);
	});

	it("never re-reads a file already resident in the cache", async () => {
		mockMap([entry("src/seed.ts"), entry("src/a.ts", ["src/seed.ts"])]);
		const cache = new WarmFileCache();
		cache.set(abs("src/a.ts"), { content: "already warm", mtimeMs: 1, size: 1 });
		const { readFileSnapshot, reads } = makeSnapshotReader({ [abs("src/a.ts")]: "fresh read" });
		const { api, fire } = makeFakePi();
		createGraphPrefetchExtension({ cwd: CWD, getWarmFileCache: () => cache, readFileSnapshot })(api);

		fire("tool_result", toolResult("read", { path: "src/seed.ts" }));
		await flush();

		expect(reads).toEqual([]);
		expect(cache.peek(abs("src/a.ts"))?.content).toBe("already warm");
	});

	it("pauses warming while a mutating tool is in flight and resumes once it ends", async () => {
		mockMap([entry("src/seed.ts"), entry("src/a.ts", ["src/seed.ts"])]);
		const cache = new WarmFileCache();
		const { readFileSnapshot, reads } = makeSnapshotReader({ [abs("src/a.ts")]: "content a" });
		const { api, fire } = makeFakePi();
		createGraphPrefetchExtension({ cwd: CWD, getWarmFileCache: () => cache, readFileSnapshot })(api);

		fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "e1", toolName: "edit", args: {} });
		fire("tool_result", toolResult("read", { path: "src/seed.ts" }));
		await flush();
		expect(reads).toEqual([]); // edit still in flight — nothing queued

		fire("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "e1",
			toolName: "edit",
			result: {},
			isError: false,
		});
		fire("tool_result", toolResult("read", { path: "src/seed.ts" }));
		await flush();
		expect(cache.peek(abs("src/a.ts"))?.content).toBe("content a"); // resumed after the edit ended
	});

	it("is fully disabled by PIT_NO_GRAPH_PREFETCH — no handlers registered, no graph fetched", async () => {
		process.env.PIT_NO_GRAPH_PREFETCH = "1";
		mockMap([entry("src/seed.ts"), entry("src/a.ts", ["src/seed.ts"])]);
		const cache = new WarmFileCache();
		const { readFileSnapshot } = makeSnapshotReader({ [abs("src/a.ts")]: "content a" });
		const { api, fire } = makeFakePi();
		createGraphPrefetchExtension({ cwd: CWD, getWarmFileCache: () => cache, readFileSnapshot })(api);

		fire("tool_result", toolResult("read", { path: "src/seed.ts" }));
		await flush();

		expect(cache.peek(abs("src/a.ts"))).toBeUndefined();
		expect(getLivingRepoMap).not.toHaveBeenCalled();
	});

	it("is a no-op when getWarmFileCache is absent or returns undefined", async () => {
		mockMap([entry("src/seed.ts"), entry("src/a.ts", ["src/seed.ts"])]);
		const { api, fire } = makeFakePi();
		createGraphPrefetchExtension({ cwd: CWD })(api);

		expect(() => fire("tool_result", toolResult("read", { path: "src/seed.ts" }))).not.toThrow();
		await flush();
		expect(getLivingRepoMap).not.toHaveBeenCalled();
	});

	it("ignores an error result and tools outside read/symbol/find_symbol", async () => {
		mockMap([entry("src/seed.ts"), entry("src/a.ts", ["src/seed.ts"])]);
		const cache = new WarmFileCache();
		const { readFileSnapshot, reads } = makeSnapshotReader({ [abs("src/a.ts")]: "content a" });
		const { api, fire } = makeFakePi();
		createGraphPrefetchExtension({ cwd: CWD, getWarmFileCache: () => cache, readFileSnapshot })(api);

		fire("tool_result", { ...toolResult("read", { path: "src/seed.ts" }), isError: true });
		fire("tool_result", toolResult("edit", { path: "src/seed.ts" }));
		fire("tool_result", toolResult("grep", { pattern: "src/seed.ts" }));
		await flush();

		expect(reads).toEqual([]);
	});

	it("degrades to no warming when a candidate read fails (fail-open), without throwing", async () => {
		mockMap([entry("src/seed.ts"), entry("src/a.ts", ["src/seed.ts"]), entry("src/b.ts", ["src/seed.ts"])]);
		const cache = new WarmFileCache();
		// "src/a.ts" is absent from the snapshot table → readFileSnapshot resolves undefined for it.
		const { readFileSnapshot } = makeSnapshotReader({ [abs("src/b.ts")]: "content b" });
		const { api, fire } = makeFakePi();
		createGraphPrefetchExtension({ cwd: CWD, getWarmFileCache: () => cache, readFileSnapshot })(api);

		expect(() => fire("tool_result", toolResult("read", { path: "src/seed.ts" }))).not.toThrow();
		await flush();

		expect(cache.peek(abs("src/a.ts"))).toBeUndefined();
		expect(cache.peek(abs("src/b.ts"))?.content).toBe("content b");
	});

	it("degrades to a no-op when the graph has no deps (PIT_NO_REPO_GRAPH shape)", async () => {
		mockMap([entry("src/seed.ts"), entry("src/a.ts")]); // no `deps` field anywhere
		const cache = new WarmFileCache();
		const { readFileSnapshot, reads } = makeSnapshotReader({ [abs("src/a.ts")]: "content a" });
		const { api, fire } = makeFakePi();
		createGraphPrefetchExtension({ cwd: CWD, getWarmFileCache: () => cache, readFileSnapshot })(api);

		fire("tool_result", toolResult("read", { path: "src/seed.ts" }));
		await flush();

		expect(reads).toEqual([]);
	});
});
