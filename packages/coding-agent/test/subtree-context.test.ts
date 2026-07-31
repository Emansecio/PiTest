/**
 * Unit coverage for the subtree-context extension (P1-4): a fake ExtensionAPI
 * captures the `tool_result` handler so we can drive it directly, with an
 * injected `readContextFile` standing in for the real filesystem.
 *
 * Virtual-fs keys are built via the SAME `resolveToolPath` the extension uses
 * internally, so the test stays platform-agnostic (Windows resolves a driveless
 * `/repo` root differently from POSIX).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	createSubtreeContextExtension,
	type SubtreeContextOptions,
	subtreeDirsBetween,
} from "../src/core/built-ins/subtree-context-extension.ts";
import { PROJECT_CONTEXT_INLINE_MAX_CHARS } from "../src/core/context-files.ts";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";
import { resolveToolPath } from "../src/core/tools/argument-prep.ts";

const CWD = resolveToolPath("subtree-repo-root", process.cwd());

type ToolResultHandler = (event: unknown) => unknown;

/** absPath -> file content. Anything absent reads as undefined (missing file). */
function makeFs(files: Record<string, string>) {
	const table = new Map<string, string>();
	for (const [rel, content] of Object.entries(files)) {
		table.set(resolveToolPath(rel, CWD), content);
	}
	const readContextFile = (absPath: string): string | undefined => table.get(absPath);
	return { table, readContextFile, key: (rel: string) => resolveToolPath(rel, CWD) };
}

function mount(options: Omit<SubtreeContextOptions, "cwd"> & { cwd?: string }) {
	let toolResultHandler: ToolResultHandler | undefined;
	const pi = {
		on(event: string, handler: (event: unknown) => unknown) {
			if (event === "tool_result") toolResultHandler = handler;
		},
	} as unknown as ExtensionAPI;

	createSubtreeContextExtension({ cwd: CWD, ...options })(pi);

	return {
		registered: () => toolResultHandler !== undefined,
		fire: (toolName: string, input: Record<string, unknown>, isError = false): string | undefined => {
			const result = toolResultHandler?.({
				type: "tool_result",
				toolName,
				toolCallId: "c1",
				input,
				content: [{ type: "text", text: "<file body>" }],
				isError,
			}) as { content?: Array<{ type: string; text?: string }> } | undefined;
			if (!result?.content) return undefined;
			// The appended block is always the LAST content entry.
			return result.content[result.content.length - 1]?.text;
		},
	};
}

afterEach(() => {
	delete process.env.PIT_NO_SUBTREE_CONTEXT;
});

describe("subtreeDirsBetween", () => {
	it("lists dirs from cwd (exclusive) down to the target (inclusive), outermost first", () => {
		const dirs = subtreeDirsBetween(CWD, resolveToolPath("packages/foo/src/a.ts", CWD));
		expect(dirs).toEqual([
			resolveToolPath("packages", CWD),
			resolveToolPath("packages/foo", CWD),
			resolveToolPath("packages/foo/src", CWD),
			resolveToolPath("packages/foo/src/a.ts", CWD),
		]);
	});

	it("is empty for a target that is cwd itself or outside cwd", () => {
		expect(subtreeDirsBetween(CWD, CWD)).toEqual([]);
		expect(subtreeDirsBetween(CWD, resolveToolPath("elsewhere/x.ts", resolveToolPath("..", CWD)))).toEqual([]);
	});
});

describe("createSubtreeContextExtension", () => {
	it("injects the subtree AGENTS.md on the first read under it", () => {
		const { readContextFile } = makeFs({ "packages/foo/AGENTS.md": "Foo package rules." });
		const ext = mount({ readContextFile });

		const text = ext.fire("read", { path: "packages/foo/src/a.ts" });
		expect(text).toContain("Foo package rules.");
		expect(text).toContain('path="packages/foo/AGENTS.md"');
		expect(text).toContain('scope="subtree"');
	});

	it("does not re-inject on a second call under the same subtree", () => {
		const { readContextFile } = makeFs({ "packages/foo/AGENTS.md": "Foo package rules." });
		const ext = mount({ readContextFile });

		expect(ext.fire("read", { path: "packages/foo/src/a.ts" })).toContain("Foo package rules.");
		expect(ext.fire("read", { path: "packages/foo/src/b.ts" })).toBeUndefined();
		expect(ext.fire("edit", { file_path: "packages/foo/src/a.ts" })).toBeUndefined();
	});

	it("injects a deeper AGENTS.md later, outermost first within one call", () => {
		const { readContextFile } = makeFs({
			"packages/AGENTS.md": "Workspace rules.",
			"packages/foo/AGENTS.md": "Foo package rules.",
		});
		const ext = mount({ readContextFile });

		const text = ext.fire("write", { path: "packages/foo/src/a.ts" }) ?? "";
		expect(text.indexOf("Workspace rules.")).toBeGreaterThan(-1);
		expect(text.indexOf("Workspace rules.")).toBeLessThan(text.indexOf("Foo package rules."));
		// Second call: both already seen.
		expect(ext.fire("write", { path: "packages/bar/x.ts" })).toBeUndefined();
	});

	it("never injects a file already loaded at boot", () => {
		const fs = makeFs({ "packages/foo/AGENTS.md": "Foo package rules." });
		const ext = mount({
			readContextFile: fs.readContextFile,
			getLoadedContextPaths: () => [fs.key("packages/foo/AGENTS.md")],
		});

		expect(ext.fire("read", { path: "packages/foo/src/a.ts" })).toBeUndefined();
	});

	it("ignores cwd/ancestor AGENTS.md and paths outside cwd", () => {
		const { readContextFile } = makeFs({
			"AGENTS.md": "Root rules (boot-loaded).",
			"../outside/AGENTS.md": "Outside rules.",
		});
		const ext = mount({ readContextFile });

		expect(ext.fire("read", { path: "src/a.ts" })).toBeUndefined();
		expect(ext.fire("read", { path: resolveToolPath("../outside/x.ts", CWD) })).toBeUndefined();
	});

	it("ignores tools with no file-path anchor", () => {
		const { readContextFile } = makeFs({ "packages/foo/AGENTS.md": "Foo package rules." });
		const ext = mount({ readContextFile });

		expect(ext.fire("grep", { path: "packages/foo" })).toBeUndefined();
		expect(ext.fire("read", {})).toBeUndefined();
	});

	it("uses an ast_edit directory target's own AGENTS.md", () => {
		const { readContextFile } = makeFs({ "packages/foo/AGENTS.md": "Foo package rules." });
		const ext = mount({ readContextFile });

		expect(ext.fire("ast_edit", { path: "packages/foo" })).toContain("Foo package rules.");
	});

	it("excerpts an oversized file with a read pointer (E6)", () => {
		const huge = `HEAD-MARKER\n${"x".repeat(PROJECT_CONTEXT_INLINE_MAX_CHARS * 2)}\nTAIL-MARKER`;
		const { readContextFile } = makeFs({ "packages/foo/AGENTS.md": huge });
		const ext = mount({ readContextFile });

		const text = ext.fire("read", { path: "packages/foo/src/a.ts" }) ?? "";
		expect(text.length).toBeLessThan(huge.length);
		expect(text).toContain("characters elided");
		expect(text).toContain('read({ path: "packages/foo/AGENTS.md" })');
		expect(text).toContain("HEAD-MARKER");
	});

	it("falls back to a read-pointer once the session aggregate cap is spent (M25a)", () => {
		const big = "y".repeat(PROJECT_CONTEXT_INLINE_MAX_CHARS - 100);
		const { readContextFile } = makeFs({
			"a/AGENTS.md": big,
			"b/AGENTS.md": big,
			// 2 x 7900 already spent; this one no longer fits under the 16 000 cap.
			"c/AGENTS.md": `Late rules that no longer fit.${"z".repeat(400)}`,
		});
		const ext = mount({ readContextFile });

		expect(ext.fire("read", { path: "a/x.ts" })).toContain(big);
		expect(ext.fire("read", { path: "b/x.ts" })).toContain(big);
		const third = ext.fire("read", { path: "c/x.ts" }) ?? "";
		expect(third).not.toContain("Late rules that no longer fit.");
		expect(third).toContain("aggregate cap reached");
		expect(third).toContain('read({ path: "c/AGENTS.md" })');
	});

	it("is a no-op under PIT_NO_SUBTREE_CONTEXT", () => {
		process.env.PIT_NO_SUBTREE_CONTEXT = "1";
		const { readContextFile } = makeFs({ "packages/foo/AGENTS.md": "Foo package rules." });
		const ext = mount({ readContextFile });

		expect(ext.registered()).toBe(false);
		expect(ext.fire("read", { path: "packages/foo/src/a.ts" })).toBeUndefined();
	});
});
