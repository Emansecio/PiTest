import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDeferredOutputStore,
	getCurrentDeferredOutputStore,
	parseDeferredStoreMemoryCap,
	setCurrentDeferredOutputStore,
} from "../src/core/deferred-output-store.js";

afterEach(() => {
	setCurrentDeferredOutputStore(undefined);
});

describe("DeferredOutputStore", () => {
	it("put→get round-trip returns the original content", () => {
		const store = createDeferredOutputStore();
		const content = "hello world\nsome tool output";
		const id = store.put(content);
		expect(id).toMatch(/^d\d+$/);
		expect(store.get(id)).toBe(content);
		store.dispose();
	});

	it("sequential puts produce distinct ids and each round-trips", () => {
		const store = createDeferredOutputStore();
		const id1 = store.put("first");
		const id2 = store.put("second");
		expect(id1).not.toBe(id2);
		expect(store.get(id1)).toBe("first");
		expect(store.get(id2)).toBe("second");
		store.dispose();
	});

	it("get of unknown id returns undefined", () => {
		const store = createDeferredOutputStore();
		expect(store.get("d999")).toBeUndefined();
		store.dispose();
	});

	it("get of malformed id (path traversal) returns undefined", () => {
		const store = createDeferredOutputStore();
		expect(store.get("../x")).toBeUndefined();
		expect(store.get("d1/../../etc/passwd")).toBeUndefined();
		expect(store.get("")).toBeUndefined();
		store.dispose();
	});

	it("dispose removes the temp dir; subsequent get does not throw", () => {
		const store = createDeferredOutputStore();
		const id = store.put("data");
		store.dispose();
		// After dispose, get should return undefined or not throw.
		let threw = false;
		let result: string | undefined;
		try {
			result = store.get(id);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBeUndefined();
	});

	it("module-level registry roundtrip", () => {
		expect(getCurrentDeferredOutputStore()).toBeUndefined();
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		expect(getCurrentDeferredOutputStore()).toBe(store);
		setCurrentDeferredOutputStore(undefined);
		expect(getCurrentDeferredOutputStore()).toBeUndefined();
		store.dispose();
	});
});

describe("DeferredOutputStore spill", () => {
	function tempSpillRoot(): string {
		return mkdtempSync(join(tmpdir(), "pit-deferred-test-"));
	}

	it("spills the oldest entries to disk above the cap; get() recovers both tiers", () => {
		const root = tempSpillRoot();
		try {
			const spillDir = join(root, "spill");
			// entryBytes = length * 2, so a 100-byte cap is a 50-char budget.
			const store = createDeferredOutputStore({ memoryCapBytes: 100, spillDir });
			const first = "a".repeat(40); // 80 bytes: under cap, stays in memory
			const second = "b".repeat(40); // 160 total: oldest (first) spills
			const id1 = store.put(first);
			expect(existsSync(spillDir)).toBe(false); // no disk I/O below the cap
			const id2 = store.put(second);
			// FIFO eviction: oldest hit disk, newest stayed in memory.
			expect(existsSync(join(spillDir, `${id1}.txt`))).toBe(true);
			expect(existsSync(join(spillDir, `${id2}.txt`))).toBe(false);
			// Hybrid get: memory→disk.
			expect(store.get(id1)).toBe(first);
			expect(store.get(id2)).toBe(second);
			store.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("spilled entry round-trips multiline/unicode content intact", () => {
		const root = tempSpillRoot();
		try {
			const spillDir = join(root, "spill");
			const store = createDeferredOutputStore({ memoryCapBytes: 8, spillDir });
			const content = "line one\nline two\ttabbed\n→ unicode ✓ émoji 🚀\nfinal";
			const id = store.put(content); // entry alone exceeds the cap → spills itself
			expect(existsSync(join(spillDir, `${id}.txt`))).toBe(true);
			expect(store.get(id)).toBe(content);
			store.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("spilled bytes pass through redactForDisk (repo disk-egress invariant)", () => {
		const root = tempSpillRoot();
		try {
			const spillDir = join(root, "spill");
			const store = createDeferredOutputStore({ memoryCapBytes: 8, spillDir });
			const secret = "AKIAABCDEFGHIJKLMNOP";
			const id = store.put(`before ${secret} after`);
			const onDisk = readFileSync(join(spillDir, `${id}.txt`), "utf8");
			expect(onDisk).not.toContain(secret);
			expect(onDisk).toContain("[REDACTED:aws-access-key]");
			// get() serves the disk copy: redacted, but otherwise intact.
			expect(store.get(id)).toBe(onDisk);
			store.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("dispose removes the spill dir and frees memory without rewriting anything", () => {
		const root = tempSpillRoot();
		try {
			const spillDir = join(root, "spill");
			const store = createDeferredOutputStore({ memoryCapBytes: 100, spillDir });
			const id1 = store.put("a".repeat(40));
			const id2 = store.put("b".repeat(40)); // forces the spill dir into existence
			expect(existsSync(spillDir)).toBe(true);
			store.dispose();
			expect(existsSync(spillDir)).toBe(false);
			expect(store.get(id1)).toBeUndefined();
			expect(store.get(id2)).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("spill I/O failure degrades to memory-only: puts never throw and content stays recoverable", () => {
		const root = tempSpillRoot();
		try {
			// A regular file where the spill dir's parent should be makes the lazy
			// mkdirSync fail with a real I/O error.
			const blocker = join(root, "blocker");
			writeFileSync(blocker, "not a dir", "utf8");
			const store = createDeferredOutputStore({ memoryCapBytes: 8, spillDir: join(blocker, "sub") });
			const first = "first entry well over the tiny cap";
			const second = "second entry, also over the cap";
			let id1 = "";
			let id2 = "";
			expect(() => {
				id1 = store.put(first);
				id2 = store.put(second); // disk already flagged unavailable: no re-attempt, no throw
			}).not.toThrow();
			expect(store.get(id1)).toBe(first);
			expect(store.get(id2)).toBe(second);
			store.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("parseDeferredStoreMemoryCap", () => {
	const DEFAULT = 16 * 1024 * 1024;

	it("defaults when unset or empty", () => {
		expect(parseDeferredStoreMemoryCap(undefined)).toBe(DEFAULT);
		expect(parseDeferredStoreMemoryCap("")).toBe(DEFAULT);
	});

	it("accepts a non-negative numeric override", () => {
		expect(parseDeferredStoreMemoryCap("1024")).toBe(1024);
		expect(parseDeferredStoreMemoryCap("0")).toBe(0);
		expect(parseDeferredStoreMemoryCap("1048576.9")).toBe(1048576);
	});

	it("falls back to the default on garbage or negative values", () => {
		expect(parseDeferredStoreMemoryCap("abc")).toBe(DEFAULT);
		expect(parseDeferredStoreMemoryCap("-5")).toBe(DEFAULT);
		expect(parseDeferredStoreMemoryCap("NaN")).toBe(DEFAULT);
		expect(parseDeferredStoreMemoryCap("Infinity")).toBe(DEFAULT);
	});
});
