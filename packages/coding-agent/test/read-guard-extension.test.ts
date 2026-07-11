/**
 * Read-guard extension — integration tests with a real temp fs and a fake
 * ExtensionAPI that collects handlers. Focus: the post-compaction WRITE warning
 * (a write overwriting a file only summarized across compaction) plus the basic
 * not-read / new-file / read-then-edit invariants.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	createReadGuardExtension,
	formatReadGuardPath,
	formatReadGuardReason,
} from "../src/core/built-ins/read-guard-extension.ts";
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
const toolResult = (toolName: string, input: Record<string, unknown>, isError = false) => ({
	toolName,
	input,
	isError,
});

describe("formatReadGuardPath / formatReadGuardReason", () => {
	it("prefers cwd-relative paths and one-line never-read reasons", () => {
		const cwd = process.platform === "win32" ? "C:\\proj" : "/proj";
		const abs = process.platform === "win32" ? "C:\\proj\\skills\\x\\_snd.txt" : "/proj/skills/x/_snd.txt";
		expect(formatReadGuardPath(abs, cwd)).toBe("skills/x/_snd.txt");
		expect(formatReadGuardReason("never-read", abs, cwd)).toBe(
			'Read guard: unread "skills/x/_snd.txt" — read it first.',
		);
	});

	it("falls back to basename when outside cwd", () => {
		const cwd = process.platform === "win32" ? "C:\\proj" : "/proj";
		const abs =
			process.platform === "win32"
				? "C:\\Users\\User\\.claude\\skills\\whatsapp\\scripts\\_snd.txt"
				: "/Users/User/.claude/skills/whatsapp/scripts/_snd.txt";
		expect(formatReadGuardPath(abs, cwd)).toBe("_snd.txt");
	});
});

describe("read-guard — basic invariants", () => {
	it("blocks an edit/write on a file that was never read this session", () => {
		const cwd = makeDir();
		writeFileSync(join(cwd, "a.ts"), "x", "utf-8");
		const { api, fire } = makeFakePi();
		createReadGuardExtension({ cwd })(api);
		const r = fire("tool_call", toolCall("write", { path: "a.ts", content: "y" }));
		expect(r?.block).toBe(true);
		expect(String(r?.reason)).toMatch(/unread/i);
		expect(String(r?.reason)).not.toMatch(/confirm its current content/i);
		expect(String(r?.reason)).toContain("a.ts");
		expect(String(r?.reason)).not.toMatch(/[A-Z]:\\/);
	});

	it("blocks edit_v2 on a file that was never read this session", () => {
		const cwd = makeDir();
		writeFileSync(join(cwd, "a.ts"), "x", "utf-8");
		const { api, fire } = makeFakePi();
		createReadGuardExtension({ cwd })(api);
		const r = fire("tool_call", toolCall("edit_v2", { path: "a.ts", edits: [] }));
		expect(r?.block).toBe(true);
		expect(String(r?.reason)).toMatch(/unread/i);
		expect(String(r?.reason)).not.toMatch(/confirm its current content/i);
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

	it("matches a read THROUGH a symlink with an edit of its TARGET (canonical key)", () => {
		const cwd = makeDir();
		writeFileSync(join(cwd, "target.ts"), "hello", "utf-8");
		// Symlink creation can fail without privilege on Windows — skip if so.
		try {
			symlinkSync(join(cwd, "target.ts"), join(cwd, "link.ts"));
		} catch {
			return;
		}
		const { api, fire } = makeFakePi();
		createReadGuardExtension({ cwd })(api);
		// Read via the symlink; edit the real target. Without canonicalization these
		// resolve to different absolute keys and the edit false-blocks as "not read".
		fire("tool_call", toolCall("read", { path: "link.ts" }));
		expect(
			fire("tool_call", toolCall("edit", { path: "target.ts", oldText: "hello", newText: "bye" })),
		).toBeUndefined();
	});

	it("matches a read of the TARGET with an edit THROUGH its symlink (canonical key)", () => {
		const cwd = makeDir();
		writeFileSync(join(cwd, "target.ts"), "hello", "utf-8");
		try {
			symlinkSync(join(cwd, "target.ts"), join(cwd, "link.ts"));
		} catch {
			return;
		}
		const { api, fire } = makeFakePi();
		createReadGuardExtension({ cwd })(api);
		fire("tool_call", toolCall("read", { path: "target.ts" }));
		expect(
			fire("tool_call", toolCall("edit", { path: "link.ts", oldText: "hello", newText: "bye" })),
		).toBeUndefined();
	});
});

describe("read-guard — intra-session drift guard (WRITE only)", () => {
	it("allows a write to a read file whose disk content is unchanged", () => {
		const cwd = makeDir();
		writeFileSync(join(cwd, "a.ts"), "export const x = 1;\n", "utf-8");
		const { api, fire } = makeFakePi();
		createReadGuardExtension({ cwd })(api);
		fire("tool_call", toolCall("read", { path: "a.ts" }));
		expect(fire("tool_call", toolCall("write", { path: "a.ts", content: "export const x = 2;\n" }))).toBeUndefined();
	});

	it("blocks a write when the file DRIFTED on disk since it was read this session (fire-once)", () => {
		const cwd = makeDir();
		writeFileSync(join(cwd, "a.ts"), "export const x = 1;\n", "utf-8");
		const { api, fire } = makeFakePi();
		createReadGuardExtension({ cwd })(api);
		fire("tool_call", toolCall("read", { path: "a.ts" }));
		// A concurrent user edit / git op changes the file after the read.
		writeFileSync(join(cwd, "a.ts"), "export const x = 1; // user touched\n", "utf-8");

		const first = fire("tool_call", toolCall("write", { path: "a.ts", content: "export const x = 2;\n" }));
		expect(first?.block).toBe(true);
		expect(String(first?.reason)).toContain("changed on disk");

		// fire-once escape: re-issuing the identical write runs it.
		expect(fire("tool_call", toolCall("write", { path: "a.ts", content: "export const x = 2;\n" }))).toBeUndefined();
	});

	it("does NOT drift-block an EDIT (edit-precondition owns oldText matching)", () => {
		const cwd = makeDir();
		writeFileSync(join(cwd, "a.ts"), "hello\n", "utf-8");
		const { api, fire } = makeFakePi();
		createReadGuardExtension({ cwd })(api);
		fire("tool_call", toolCall("read", { path: "a.ts" }));
		writeFileSync(join(cwd, "a.ts"), "hello world\n", "utf-8");
		expect(fire("tool_call", toolCall("edit", { path: "a.ts", oldText: "hello", newText: "bye" }))).toBeUndefined();
	});

	it("re-stamps after the model's OWN write so a second write is not a false drift", () => {
		const cwd = makeDir();
		writeFileSync(join(cwd, "a.ts"), "export const x = 1;\n", "utf-8");
		const { api, fire } = makeFakePi();
		createReadGuardExtension({ cwd })(api);
		fire("tool_call", toolCall("read", { path: "a.ts" }));

		// First write is allowed; simulate it landing on disk + the success result.
		expect(fire("tool_call", toolCall("write", { path: "a.ts", content: "export const x = 2;\n" }))).toBeUndefined();
		writeFileSync(join(cwd, "a.ts"), "export const x = 2;\n", "utf-8");
		fire("tool_result", toolResult("write", { path: "a.ts", content: "export const x = 2;\n" }));

		// Second write must NOT be blocked as drift — the model itself made the change.
		expect(fire("tool_call", toolCall("write", { path: "a.ts", content: "export const x = 3;\n" }))).toBeUndefined();
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
		expect(String(first?.reason)).toMatch(/post-compact|overwrite/i);

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
		expect(String(r?.reason)).toMatch(/stale/i);
	});
});

describe("read-guard — write-warning override telemetry (acceptance vs block)", () => {
	// The runtime-diagnostics sink is a process-global singleton; reset it so this
	// test reads only its own events (source = read-guard-extension.*).
	afterEach(() => resetRuntimeDiagnostics());

	function readGuardSources(): string[] {
		return getRuntimeDiagnostics()
			.recent.filter((e) => e.source.startsWith("read-guard-extension."))
			.map((e) => e.source);
	}

	it("blocks the 1st write on drift (outcome=blocked) then records an override on the identical re-issue", () => {
		resetRuntimeDiagnostics();
		const cwd = makeDir();
		writeFileSync(join(cwd, "a.ts"), "export const x = 1;\n", "utf-8");
		const { api, fire } = makeFakePi();
		createReadGuardExtension({ cwd })(api);

		fire("tool_call", toolCall("read", { path: "a.ts" }));
		// Concurrent change after the read => intra-session drift.
		writeFileSync(join(cwd, "a.ts"), "export const x = 1; // user touched\n", "utf-8");

		// 1st write blocks (warn fires once).
		const first = fire("tool_call", toolCall("write", { path: "a.ts", content: "export const x = 2;\n" }));
		expect(first?.block).toBe(true);

		// 2nd identical write passes (fire-once escape) AND records the override.
		const second = fire("tool_call", toolCall("write", { path: "a.ts", content: "export const x = 2;\n" }));
		expect(second).toBeUndefined();

		const snap = getRuntimeDiagnostics();
		const blocked = snap.recent.find((e) => e.source === "read-guard-extension.intraSessionDrift");
		const overridden = snap.recent.find((e) => e.source === "read-guard-extension.writeWarnOverridden");
		expect(blocked?.context?.outcome).toBe("blocked");
		expect(blocked?.context?.ruleId).toBe("write-drift-clobber");
		expect(overridden?.context?.outcome).toBe("overridden");
		expect(overridden?.context?.ruleId).toBe("write-drift-clobber");
		expect(overridden?.context?.path).toBe("a.ts");
		// Exactly one block + one override (no double-fire on the override path).
		expect(readGuardSources().filter((s) => s === "read-guard-extension.writeWarnOverridden")).toHaveLength(1);
	});

	it("records an override when a post-compaction write-warning is re-issued", () => {
		resetRuntimeDiagnostics();
		const cwd = makeDir();
		writeFileSync(join(cwd, "a.ts"), "export const x = 1;\n", "utf-8");
		const { api, fire } = makeFakePi();
		createReadGuardExtension({ cwd })(api);

		fire("tool_call", toolCall("read", { path: "a.ts" }));
		fire("session_before_compact", {});

		// 1st write blocks (postCompactWriteWarn, outcome=blocked).
		const first = fire("tool_call", toolCall("write", { path: "a.ts", content: "export const x = 2;\n" }));
		expect(first?.block).toBe(true);
		// 2nd identical write passes AND records the override.
		expect(fire("tool_call", toolCall("write", { path: "a.ts", content: "export const x = 2;\n" }))).toBeUndefined();

		const snap = getRuntimeDiagnostics();
		const blocked = snap.recent.find((e) => e.source === "read-guard-extension.postCompactWriteWarn");
		const overridden = snap.recent.find((e) => e.source === "read-guard-extension.writeWarnOverridden");
		expect(blocked?.context?.outcome).toBe("blocked");
		expect(blocked?.context?.ruleId).toBe("postcompact-write-overwrite");
		expect(overridden?.context?.outcome).toBe("overridden");
		expect(overridden?.context?.ruleId).toBe("postcompact-write-overwrite");
	});

	it("does NOT record an override for a normal write to a read, undrifted file", () => {
		resetRuntimeDiagnostics();
		const cwd = makeDir();
		writeFileSync(join(cwd, "a.ts"), "export const x = 1;\n", "utf-8");
		const { api, fire } = makeFakePi();
		createReadGuardExtension({ cwd })(api);

		fire("tool_call", toolCall("read", { path: "a.ts" }));
		// File unchanged => no warning ever entered firedWriteWarnings.
		expect(fire("tool_call", toolCall("write", { path: "a.ts", content: "export const x = 2;\n" }))).toBeUndefined();

		expect(readGuardSources()).not.toContain("read-guard-extension.writeWarnOverridden");
	});
});
