/**
 * Unit coverage for the external-edit sentinel: a fake ExtensionAPI captures the
 * `tool_result` (registration) and `before_agent_start` (sweep) handlers so we can
 * drive them directly, with an injected `statFile` standing in for the real
 * filesystem.
 *
 * Stat-table keys are built via the SAME `resolveToolPath` the extension uses
 * internally, so the test stays platform-agnostic (Windows resolves a
 * driveless `/repo` root differently from POSIX).
 */

import { describe, expect, it } from "vitest";
import {
	createExternalEditSentinelExtension,
	type ExternalEditSentinelOptions,
	type FileStatSnapshot,
} from "../src/core/built-ins/external-edit-sentinel-extension.ts";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";
import { resolveToolPath } from "../src/core/tools/argument-prep.ts";
import type { ReadDedupeStore } from "../src/core/tools/read.ts";

const CWD = resolveToolPath("repo-root", process.cwd());

type ToolResultHandler = (event: unknown) => Promise<void> | void;
type BeforeAgentStartHandler = () => Promise<
	{ message?: { customType: string; content: unknown; display: boolean } } | undefined
>;

/** Controllable stand-in for the real filesystem: absPath -> current stat (or undefined = missing/dir). */
function makeStatTable() {
	const table = new Map<string, FileStatSnapshot | undefined>();
	const statFile = async (absPath: string): Promise<FileStatSnapshot | undefined> => table.get(absPath);
	/** Resolve a bare filename the same way the extension resolves tool `path` args. */
	const key = (name: string) => resolveToolPath(name, CWD);
	return { table, statFile, key };
}

function makeFakeDedupeStore() {
	const invalidated: string[] = [];
	const store = { invalidatePath: (key: string) => invalidated.push(key) } as unknown as ReadDedupeStore;
	return { store, invalidated };
}

function mountExtension(options: Omit<ExternalEditSentinelOptions, "cwd"> & { cwd?: string }) {
	let toolResultHandler: ToolResultHandler | undefined;
	let beforeAgentStartHandler: BeforeAgentStartHandler | undefined;
	const pi = {
		on(event: string, handler: (event: unknown) => unknown) {
			if (event === "tool_result") toolResultHandler = handler as ToolResultHandler;
			if (event === "before_agent_start") beforeAgentStartHandler = handler as BeforeAgentStartHandler;
		},
		markMessageInjector<F>(handler: F): F {
			return handler;
		},
	} as unknown as ExtensionAPI;

	createExternalEditSentinelExtension({ cwd: CWD, ...options })(pi);

	return {
		fireToolResult: async (toolName: string, input: Record<string, unknown>, isError = false) => {
			await toolResultHandler?.({ type: "tool_result", toolName, input, content: [], isError });
		},
		fireBeforeAgentStart: async () => beforeAgentStartHandler?.(),
		registered: () => ({ hasToolResult: !!toolResultHandler, hasBeforeAgentStart: !!beforeAgentStartHandler }),
	};
}

function noteText(result: { message?: { content: unknown } } | undefined): string | undefined {
	const content = result?.message?.content;
	return typeof content === "string" ? content : undefined;
}

describe("createExternalEditSentinelExtension", () => {
	it("registers a baseline on a successful read and stays quiet when disk is unchanged", async () => {
		const { table, statFile, key } = makeStatTable();
		table.set(key("foo.ts"), { mtimeMs: 1000, size: 10 });
		const { fireToolResult, fireBeforeAgentStart } = mountExtension({ statFile });

		await fireToolResult("read", { path: "foo.ts" });
		const result = await fireBeforeAgentStart();

		expect(result).toBeUndefined();
	});

	it("does not alert on the session's own write (baseline refreshed at write time)", async () => {
		const { table, statFile, key } = makeStatTable();
		table.set(key("foo.ts"), { mtimeMs: 1000, size: 10 });
		const { fireToolResult, fireBeforeAgentStart } = mountExtension({ statFile });

		// Pit writes the file — the tool_result handler re-baselines to the
		// post-write stat, exactly like FileMtimeStore's own refresh-after-write.
		await fireToolResult("write", { path: "foo.ts" });
		table.set(key("foo.ts"), { mtimeMs: 1000, size: 10 }); // disk settles at the value we just wrote

		const result = await fireBeforeAgentStart();
		expect(result).toBeUndefined();
	});

	it("registers via edit_v2 and ast_edit (not just read/edit/write)", async () => {
		const { table, statFile, key } = makeStatTable();
		table.set(key("a.ts"), { mtimeMs: 1000, size: 10 });
		table.set(key("b.ts"), { mtimeMs: 2000, size: 20 });
		const { fireToolResult, fireBeforeAgentStart } = mountExtension({ statFile });

		await fireToolResult("edit_v2", { path: "a.ts" });
		await fireToolResult("ast_edit", { path: "b.ts" });

		// External changes to both, now that both are tracked.
		const now = Date.now();
		table.set(key("a.ts"), { mtimeMs: now - 5000, size: 11 });
		table.set(key("b.ts"), { mtimeMs: now - 5000, size: 21 });

		const result = await fireBeforeAgentStart();
		const text = noteText(result);
		expect(text).toContain("a.ts");
		expect(text).toContain("b.ts");
		expect(text).toContain("2 file(s) changed");
	});

	it("skips ast_edit registration when path resolves to a directory (statFile reports undefined)", async () => {
		const { statFile } = makeStatTable();
		// No entry for the directory path — statFile returns undefined, as it would
		// for a real directory (defaultStatFile checks isDirectory()).
		const { fireToolResult, fireBeforeAgentStart } = mountExtension({ statFile });

		await fireToolResult("ast_edit", { path: "src" });
		const result = await fireBeforeAgentStart();
		expect(result).toBeUndefined();
	});

	it("does not register a failed tool call", async () => {
		const { table, statFile, key } = makeStatTable();
		table.set(key("foo.ts"), { mtimeMs: 1000, size: 10 });
		const { fireToolResult, fireBeforeAgentStart } = mountExtension({ statFile });

		await fireToolResult("edit", { path: "foo.ts" }, true);
		// Even though disk "changes" afterwards, nothing was baselined so nothing fires.
		table.set(key("foo.ts"), { mtimeMs: 9000, size: 99 });
		const result = await fireBeforeAgentStart();
		expect(result).toBeUndefined();
	});

	it("ignores tools outside the tracked set (e.g. bash)", async () => {
		const { statFile } = makeStatTable();
		const { fireToolResult, fireBeforeAgentStart } = mountExtension({ statFile });

		await fireToolResult("bash", { path: "foo.ts", command: "echo hi" });
		const result = await fireBeforeAgentStart();
		expect(result).toBeUndefined();
	});

	it("fires on an external mtime/size change with a dense (+Ns) note and invalidates the dedupe entry", async () => {
		const { table, statFile, key } = makeStatTable();
		table.set(key("foo.ts"), { mtimeMs: 1000, size: 10 });
		const { store, invalidated } = makeFakeDedupeStore();
		const { fireToolResult, fireBeforeAgentStart } = mountExtension({ statFile, getReadDedupeStore: () => store });

		await fireToolResult("read", { path: "foo.ts" });

		const changedAt = Date.now() - 42_000;
		table.set(key("foo.ts"), { mtimeMs: changedAt, size: 11 });

		const result = await fireBeforeAgentStart();
		const text = noteText(result);
		expect(text).toBe(
			"1 file(s) changed outside the session since last read: foo.ts (+42s). Re-read before editing.",
		);
		expect(result?.message?.display).toBe(true);
		expect(result?.message?.customType).toBe("pi.external-edit-sentinel");
		expect(invalidated).toHaveLength(1);
	});

	it("fires on deletion with a (removed) note and stops tracking the path", async () => {
		const { table, statFile, key } = makeStatTable();
		table.set(key("foo.ts"), { mtimeMs: 1000, size: 10 });
		const { store, invalidated } = makeFakeDedupeStore();
		const { fireToolResult, fireBeforeAgentStart } = mountExtension({ statFile, getReadDedupeStore: () => store });

		await fireToolResult("read", { path: "foo.ts" });
		table.delete(key("foo.ts")); // statFile now returns undefined — deleted

		const first = await fireBeforeAgentStart();
		expect(noteText(first)).toBe(
			"1 file(s) changed outside the session since last read: foo.ts (removed). Re-read before editing.",
		);
		expect(invalidated).toEqual([expect.any(String)]);

		// Second sweep: the path was dropped from the registry on report, so it is
		// not re-alerted even though it is still missing.
		const second = await fireBeforeAgentStart();
		expect(second).toBeUndefined();
	});

	it("caps the listed files at 8 and folds the rest into a +N more suffix", async () => {
		const { table, statFile, key } = makeStatTable();
		const paths = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
		for (const p of paths) table.set(key(p), { mtimeMs: 1000, size: 10 });
		const { fireToolResult, fireBeforeAgentStart } = mountExtension({ statFile });

		for (const p of paths) await fireToolResult("read", { path: p });
		for (const p of paths) table.set(key(p), { mtimeMs: 2000, size: 11 });

		const result = await fireBeforeAgentStart();
		const text = noteText(result);
		expect(text).toContain("10 file(s) changed");
		expect(text).toContain("+2 more");
		// Exactly 8 individual "(+Ns)" markers should be listed.
		expect(text?.match(/\(\+\d+s\)/g)).toHaveLength(8);
	});

	it("updates the baseline after reporting so the same drift is not re-alerted", async () => {
		const { table, statFile, key } = makeStatTable();
		table.set(key("foo.ts"), { mtimeMs: 1000, size: 10 });
		const { fireToolResult, fireBeforeAgentStart } = mountExtension({ statFile });

		await fireToolResult("read", { path: "foo.ts" });
		table.set(key("foo.ts"), { mtimeMs: 5000, size: 12 });

		const first = await fireBeforeAgentStart();
		expect(noteText(first)).toBeDefined();

		// No further disk change — the second sweep must be quiet.
		const second = await fireBeforeAgentStart();
		expect(second).toBeUndefined();
	});

	it("is fully disabled by PIT_NO_EXTERNAL_EDIT_SENTINEL — no handlers registered at all", async () => {
		const { table, statFile, key } = makeStatTable();
		table.set(key("foo.ts"), { mtimeMs: 1000, size: 10 });
		const prev = process.env.PIT_NO_EXTERNAL_EDIT_SENTINEL;
		process.env.PIT_NO_EXTERNAL_EDIT_SENTINEL = "1";
		try {
			const { registered, fireToolResult, fireBeforeAgentStart } = mountExtension({ statFile });
			expect(registered()).toEqual({ hasToolResult: false, hasBeforeAgentStart: false });
			await fireToolResult("read", { path: "foo.ts" });
			expect(await fireBeforeAgentStart()).toBeUndefined();
		} finally {
			if (prev === undefined) delete process.env.PIT_NO_EXTERNAL_EDIT_SENTINEL;
			else process.env.PIT_NO_EXTERNAL_EDIT_SENTINEL = prev;
		}
	});
});
