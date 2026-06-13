/**
 * Read-guard extension — integration tests with a real temp fs and a fake
 * ExtensionAPI that collects handlers. Focus: the post-compaction WRITE warning
 * (a write overwriting a file only summarized across compaction) plus the basic
 * not-read / new-file / read-then-edit invariants.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReadGuardExtension } from "../src/core/built-ins/read-guard-extension.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

type Handler = (event: any) => unknown;

function makeFakePi() {
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	const fire = (event: string, payload: any): any => {
		let result: any;
		for (const handler of handlers.get(event) ?? []) {
			const r = handler(payload);
			if (r !== undefined && result === undefined) result = r;
		}
		return result;
	};
	return { api, fire };
}

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) {
		const d = dirs.pop();
		if (d) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}
});
function makeDir(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-readguard-"));
	dirs.push(d);
	return d;
}

const toolCall = (toolName: string, input: Record<string, unknown>) => ({ toolName, input });

describe("read-guard — basic invariants", () => {
	it("blocks an edit/write on a file that was never read this session", () => {
		const cwd = makeDir();
		writeFileSync(join(cwd, "a.ts"), "x", "utf-8");
		const { api, fire } = makeFakePi();
		createReadGuardExtension({ cwd })(api);
		const r = fire("tool_call", toolCall("write", { path: "a.ts", content: "y" }));
		expect(r?.block).toBe(true);
		expect(String(r?.reason)).toContain("has not been read");
	});

	it("allows a write to a NEW file (does not exist on disk)", () => {
		const cwd = makeDir();
		const { api, fire } = makeFakePi();
		createReadGuardExtension({ cwd })(api);
		expect(fire("tool_call", toolCall("write", { path: "new.ts", content: "y" }))).toBeUndefined();
	});

	it("allows an edit after the file was read this session", () => {
		const cwd = makeDir();
		writeFileSync(join(cwd, "a.ts"), "hello", "utf-8");
		const { api, fire } = makeFakePi();
		createReadGuardExtension({ cwd })(api);
		fire("tool_call", toolCall("read", { path: "a.ts" }));
		expect(fire("tool_call", toolCall("edit", { path: "a.ts", oldText: "hello", newText: "bye" }))).toBeUndefined();
	});
});

describe("read-guard — post-compaction WRITE warning (the reinforcement)", () => {
	it("warns ONCE on a write overwriting a file only summarized across compaction, then runs on re-issue", () => {
		const cwd = makeDir();
		writeFileSync(join(cwd, "a.ts"), "export const x = 1;\n", "utf-8");
		const { api, fire } = makeFakePi();
		createReadGuardExtension({ cwd })(api);

		// read -> compaction (migrates readFiles to a stat snapshot) -> the file is
		// unchanged on disk, so the model is "anchored" only to the lossy summary.
		fire("tool_call", toolCall("read", { path: "a.ts" }));
		fire("session_before_compact", {});

		const first = fire("tool_call", toolCall("write", { path: "a.ts", content: "export const x = 2;\n" }));
		expect(first?.block).toBe(true);
		expect(String(first?.reason)).toContain("OVERWRITE");

		// fire-once escape: re-issuing the identical write runs it.
		const second = fire("tool_call", toolCall("write", { path: "a.ts", content: "export const x = 2;\n" }));
		expect(second).toBeUndefined();
	});

	it("a re-read after compaction clears the warning gate (write then allowed)", () => {
		const cwd = makeDir();
		writeFileSync(join(cwd, "a.ts"), "export const x = 1;\n", "utf-8");
		const { api, fire } = makeFakePi();
		createReadGuardExtension({ cwd })(api);

		fire("tool_call", toolCall("read", { path: "a.ts" }));
		fire("session_before_compact", {});
		// Re-read supersedes the stamp gate entirely.
		fire("tool_call", toolCall("read", { path: "a.ts" }));
		expect(fire("tool_call", toolCall("write", { path: "a.ts", content: "export const x = 2;\n" }))).toBeUndefined();
	});

	it("still blocks (no fire-once) a write when the file DRIFTED since pre-compaction read", () => {
		const cwd = makeDir();
		writeFileSync(join(cwd, "a.ts"), "export const x = 1;\n", "utf-8");
		const { api, fire } = makeFakePi();
		createReadGuardExtension({ cwd })(api);

		fire("tool_call", toolCall("read", { path: "a.ts" }));
		fire("session_before_compact", {});
		// Another process changes the file after the snapshot.
		writeFileSync(join(cwd, "a.ts"), "export const x = 999; // changed\n", "utf-8");

		const r = fire("tool_call", toolCall("write", { path: "a.ts", content: "export const x = 2;\n" }));
		expect(r?.block).toBe(true);
		expect(String(r?.reason)).toContain("changed since");
	});
});
