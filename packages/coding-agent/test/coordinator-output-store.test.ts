/**
 * N7 — disk-backed store for a subagent's integral output.
 *
 * Mirrors the deferred-output-store guarantees: bytes on disk pass through
 * redactForDisk (repo invariant), get() reads back the persisted (redacted)
 * content, re-storing a handle overwrites the same file, and dispose() removes
 * the temp dir so nothing leaks past the session.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSubagentOutputStore } from "../src/core/coordinator/output-store.js";

describe("createSubagentOutputStore (N7)", () => {
	const dirs: string[] = [];
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

	it("persists and retrieves the integral output by handle", () => {
		const store = createSubagentOutputStore({ dir: freshDir() });
		store.put("task-a", "the full integral output");
		expect(store.get("task-a")).toBe("the full integral output");
		expect(store.get("never-stored")).toBeUndefined();
		store.dispose();
	});

	it("redacts secrets before they land on disk (repo invariant)", () => {
		const dir = freshDir();
		const store = createSubagentOutputStore({ dir });
		const secret = "sk-ant-0123456789abcdef0123456789abcdef";
		store.put("leaky", `here is a key ${secret} in the output`);

		// Read the raw file straight off disk — it must be redacted, not verbatim.
		const files = readdirSync(dir).filter((f) => f.endsWith(".txt"));
		expect(files.length).toBe(1);
		const onDisk = readFileSync(join(dir, files[0]), "utf8");
		expect(onDisk).not.toContain(secret);
		expect(onDisk).toContain("[REDACTED");
		// get() reads from disk, so it returns the redacted form.
		expect(store.get("leaky")).not.toContain(secret);
		store.dispose();
	});

	it("re-storing a handle overwrites the same file (latest output wins)", () => {
		const dir = freshDir();
		const store = createSubagentOutputStore({ dir });
		store.put("h", "first");
		store.put("h", "second (after resume/continue)");
		expect(store.get("h")).toBe("second (after resume/continue)");
		expect(readdirSync(dir).filter((f) => f.endsWith(".txt")).length).toBe(1);
		store.dispose();
	});

	it("dispose removes the temp dir and get returns undefined afterwards", () => {
		const dir = freshDir();
		const store = createSubagentOutputStore({ dir });
		store.put("h", "content");
		expect(existsSync(dir)).toBe(true);
		store.dispose();
		expect(existsSync(dir)).toBe(false);
		expect(store.get("h")).toBeUndefined();
	});
});
