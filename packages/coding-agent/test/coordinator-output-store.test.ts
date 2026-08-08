/**
 * N7 — disk-backed store for a subagent's integral output.
 *
 * Mirrors the deferred-output-store guarantees: bytes on disk pass through
 * redactForDisk (repo invariant), get() reads back the persisted (redacted)
 * content, re-storing a handle overwrites the same file, and dispose() removes
 * the temp dir so nothing leaks past the session.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSubagentOutputStore } from "../src/core/coordinator/output-store.js";

describe("createSubagentOutputStore (N7)", () => {
	const dirs: string[] = [];
	beforeEach(() => resetRuntimeDiagnostics());
	function freshDir(): string {
		const d = mkdtempSync(join(tmpdir(), "pit-subagent-test-"));
		dirs.push(d);
		return d;
	}
	afterEach(() => {
		// The store disposes its own dir; this only cleans dirs a test kept alive.
		for (const d of dirs.splice(0)) {
			try {
				if (existsSync(d)) readdirSync(d);
			} catch {
				// ignore
			}
		}
	});

	it("persists and retrieves the integral output by handle", async () => {
		const store = createSubagentOutputStore({ dir: freshDir() });
		await store.put("task-a", "the full integral output");
		expect(await store.get("task-a")).toBe("the full integral output");
		expect(await store.get("never-stored")).toBeUndefined();
		await store.dispose();
	});

	it("redacts secrets before they land on disk (repo invariant)", async () => {
		const dir = freshDir();
		const store = createSubagentOutputStore({ dir });
		const secret = "sk-ant-0123456789abcdef0123456789abcdef";
		await store.put("leaky", `here is a key ${secret} in the output`);

		// Read the raw file straight off disk — it must be redacted, not verbatim.
		const files = readdirSync(dir).filter((f) => f.endsWith(".txt"));
		expect(files.length).toBe(1);
		const onDisk = readFileSync(join(dir, files[0]), "utf8");
		expect(onDisk).not.toContain(secret);
		expect(onDisk).toContain("[REDACTED");
		// get() reads from disk, so it returns the redacted form.
		expect(await store.get("leaky")).not.toContain(secret);
		await store.dispose();
	});

	it("re-storing a handle overwrites the same file (latest output wins)", async () => {
		const dir = freshDir();
		const store = createSubagentOutputStore({ dir });
		await store.put("h", "first");
		await store.put("h", "second (after resume/continue)");
		expect(await store.get("h")).toBe("second (after resume/continue)");
		expect(readdirSync(dir).filter((f) => f.endsWith(".txt")).length).toBe(1);
		await store.dispose();
	});

	it("reads deterministic UTF-8-safe byte pages without gaps or replacement characters", async () => {
		const store = createSubagentOutputStore({ dir: freshDir() });
		const expected = `head-${"é".repeat(20)}-${"🙂".repeat(20)}-tail`;
		await store.put("paged", expected);
		let cursor = 0;
		let reconstructed = "";
		for (let pages = 0; pages < 100; pages += 1) {
			const page = await store.getPage("paged", cursor, 11);
			expect(page).toBeDefined();
			if (!page) break;
			expect(page.content).not.toContain("�");
			expect(Buffer.byteLength(page.content, "utf8")).toBeLessThanOrEqual(11);
			reconstructed += page.content;
			if (!page.hasMore) break;
			expect(page.nextCursor).toBeGreaterThan(cursor);
			cursor = page.nextCursor!;
		}
		expect(reconstructed).toBe(expected);
		await store.dispose();
	});

	it("rejects a cursor inside a UTF-8 code point and returns undefined for missing handles", async () => {
		const store = createSubagentOutputStore({ dir: freshDir() });
		await store.put("utf8", "éclair");
		await expect(store.getPage("utf8", 1, 8)).rejects.toThrow(/UTF-8 boundary/i);
		expect(await store.getPage("missing", 0, 8)).toBeUndefined();
		await store.dispose();
	});

	it("diagnoses an unexpected retention write failure without rejecting put", async () => {
		const root = freshDir();
		const blocked = join(root, "not-a-directory");
		writeFileSync(blocked, "file");
		const store = createSubagentOutputStore({ dir: blocked });

		await expect(store.put("h", "content")).resolves.toBeUndefined();

		const events = getRuntimeDiagnostics().recent.filter((event) => event.category === "subagent.retention-failed");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ level: "error", source: "subagent-output-store" });
		expect(events[0]?.context?.mechanism).toBe("mkdir");
		await store.dispose();
	});

	it("bounds retained output bytes", async () => {
		const dir = freshDir();
		const store = createSubagentOutputStore({ dir, maxEntries: 2, maxBytes: 20 });
		await store.put("a", "1234567890");
		await store.put("b", "abcdefghij");
		await store.put("c", "klmnopqrst");
		expect(await store.get("a")).toBeUndefined();
		expect(await store.get("c")).toBe("klmnopqrst");
		await store.dispose();
	});

	it("dispose removes the temp dir and get returns undefined afterwards", async () => {
		const dir = freshDir();
		const store = createSubagentOutputStore({ dir });
		await store.put("h", "content");
		expect(existsSync(dir)).toBe(true);
		await store.dispose();
		expect(existsSync(dir)).toBe(false);
		expect(await store.get("h")).toBeUndefined();
	});
});
