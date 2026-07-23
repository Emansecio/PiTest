/**
 * P1 speculative-execution wiring in the coding-agent tool registry:
 *  - SPECULATION_SAFE_TOOLS ∩ readOnly stamp (packages/coding-agent/src/core/tools/index.ts, `buildTool`)
 *  - the read tool's `onSpeculationDiscarded` un-records its dedupe entry
 *    (packages/coding-agent/src/core/tools/read.ts)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTool } from "../src/core/tools/index.js";
import { canonicalPathKey, resolveReadPath } from "../src/core/tools/path-utils.js";
import { createReadTool, ReadDedupeStore } from "../src/core/tools/read.js";

describe("createTool: speculationSafe stamp on the built tool surface", () => {
	it("read/grep/find/ls are stamped speculationSafe === true", () => {
		for (const name of ["read", "grep", "find", "ls"] as const) {
			const tool = createTool(name, process.cwd());
			expect(tool.speculationSafe).toBe(true);
		}
	});

	it("write/edit/bash/web_search are NOT speculationSafe", () => {
		for (const name of ["write", "edit", "bash", "web_search"] as const) {
			const tool = createTool(name, process.cwd());
			expect(tool.speculationSafe).not.toBe(true);
		}
	});
});

describe("read tool: onSpeculationDiscarded un-records the dedupe entry", () => {
	const dir = mkdtempSync(join(tmpdir(), "pit-speculation-read-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("removes the ReadDedupeStore entry a discarded speculative read had recorded", () => {
		const store = new ReadDedupeStore();
		const tool = createReadTool(dir, { readDedupeStore: store, embedHashlineAnchors: false });
		expect(tool.onSpeculationDiscarded).toBeTypeOf("function");

		const relPath = "foo.txt";
		writeFileSync(join(dir, relPath), "hello world\n");

		// Build the SAME dedupe key the read tool's execute path uses for a
		// full-file read: `${canonicalPathKey(absPath)} ${offset ?? ""} ${limit ?? ""}`
		// (readDedupeKey in read.ts — not exported, so replicated here from source).
		const absPath = resolveReadPath(relPath, dir);
		const canonicalKey = canonicalPathKey(absPath);
		const dedupeKey = `${canonicalKey} ${""} ${""}`;

		// Simulate what a speculative (never-delivered) read would have recorded.
		store.record(dedupeKey, "fake-hash", "hello world\n", true);
		expect(store.peek(dedupeKey)).toBeDefined();

		// Discard it — mirrors what SpeculationController.discardEntry does on
		// the loop side: call onSpeculationDiscarded(toolCallId, args) with the
		// same `path` shape the tool's execute receives.
		tool.onSpeculationDiscarded?.("spec-call-1", { path: relPath });

		expect(store.peek(dedupeKey)).toBeUndefined();
	});

	it("is a no-op when no readDedupeStore is configured (never throws)", () => {
		const tool = createReadTool(dir, { embedHashlineAnchors: false });
		expect(() => tool.onSpeculationDiscarded?.("spec-call-2", { path: "foo.txt" })).not.toThrow();
	});

	it("is a no-op for a malformed/missing path arg", () => {
		const store = new ReadDedupeStore();
		const tool = createReadTool(dir, { readDedupeStore: store, embedHashlineAnchors: false });
		expect(() => tool.onSpeculationDiscarded?.("spec-call-3", {})).not.toThrow();
		expect(() => tool.onSpeculationDiscarded?.("spec-call-4", { path: 42 })).not.toThrow();
	});
});
