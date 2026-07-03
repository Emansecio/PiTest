import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Box } from "@pit/tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.js";
import { createEditToolDefinition } from "../src/core/tools/edit.js";
import * as editDiffModule from "../src/core/tools/edit-diff.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

// Exercises the live-preview throttle/memoization added to `edit`'s
// `renderCall` (edit.ts, ~L526-609): argsKey is memoized on args reference
// identity (no re-stringify on unrelated re-renders), and
// `computeEditsDiffWithBaseCache` dispatch is throttled to ~10Hz while args
// stream, with a guaranteed immediate dispatch once `argsComplete`. Old
// previews stay visible (stale-while-revalidate) while a newer recompute is
// pending/throttled.

type CallState = { callComponent?: Box & Record<string, unknown> };

function makeContext(
	state: CallState,
	overrides: Partial<ToolRenderContext> = {},
): ToolRenderContext & { invalidateCount: number } {
	let invalidateCount = 0;
	const ctx = {
		args: undefined,
		toolCallId: "tool-call-1",
		invalidate: () => {
			invalidateCount++;
		},
		lastComponent: state.callComponent,
		state,
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: false,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		activityChild: false,
		...overrides,
	} as ToolRenderContext & { invalidateCount: number };
	Object.defineProperty(ctx, "invalidateCount", {
		get: () => invalidateCount,
	});
	return ctx;
}

describe("edit renderCall live-preview throttle", () => {
	const tempDirs: string[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	async function makeFile(contents: string): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-throttle-"));
		tempDirs.push(dir);
		const filePath = join(dir, "file.txt");
		await writeFile(filePath, contents, "utf8");
		return filePath;
	}

	it("dispatches only once for N streamed chunks within the 100ms throttle window", async () => {
		const filePath = await makeFile("hello\nworld\n");
		const def = createEditToolDefinition(process.cwd());
		const spy = vi.spyOn(editDiffModule, "computeEditsDiffWithBaseCache");
		const state: CallState = {};

		for (let i = 0; i < 5; i++) {
			const ctx = makeContext(state, { lastComponent: state.callComponent });
			def.renderCall?.({ path: filePath, edits: [{ oldText: "hello", newText: `hello${i}` }] }, theme, ctx);
		}
		// Give the single in-flight compute a chance to resolve.
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("dispatches immediately on argsComplete even inside the throttle window", async () => {
		const filePath = await makeFile("hello\nworld\n");
		const def = createEditToolDefinition(process.cwd());
		const spy = vi.spyOn(editDiffModule, "computeEditsDiffWithBaseCache");
		const state: CallState = {};

		const ctx1 = makeContext(state, { lastComponent: state.callComponent });
		def.renderCall?.({ path: filePath, edits: [{ oldText: "hello", newText: "hello1" }] }, theme, ctx1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(spy).toHaveBeenCalledTimes(1);

		// Second chunk arrives well within the 100ms window but with argsComplete
		// true — must bypass the throttle and dispatch right away.
		const ctx2 = makeContext(state, { lastComponent: state.callComponent, argsComplete: true });
		def.renderCall?.({ path: filePath, edits: [{ oldText: "hello", newText: "hello-final" }] }, theme, ctx2);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("does not re-serialize args when the same args reference is re-rendered", async () => {
		const filePath = await makeFile("hello\nworld\n");
		const def = createEditToolDefinition(process.cwd());
		const state: CallState = {};
		const stringifySpy = vi.spyOn(JSON, "stringify");

		const args = { path: filePath, edits: [{ oldText: "hello", newText: "hello1" }] };
		const ctx1 = makeContext(state, { lastComponent: state.callComponent });
		def.renderCall?.(args, theme, ctx1);
		const callsAfterFirst = stringifySpy.mock.calls.length;
		expect(callsAfterFirst).toBeGreaterThan(0);

		stringifySpy.mockClear();
		// Re-render with the SAME args reference (e.g. setExpanded, a theme
		// invalidate, setShowImages) — must not re-stringify.
		const ctx2 = makeContext(state, { lastComponent: state.callComponent, expanded: true });
		def.renderCall?.(args, theme, ctx2);
		expect(stringifySpy).not.toHaveBeenCalled();

		await new Promise((resolve) => setTimeout(resolve, 20));
	});

	it("keeps the last computed preview visible while a newer recompute is pending/throttled", async () => {
		const filePath = await makeFile(`${Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")}\n`);
		const def = createEditToolDefinition(process.cwd());
		const state: CallState = {};

		const ctx1 = makeContext(state, { lastComponent: state.callComponent });
		def.renderCall?.({ path: filePath, edits: [{ oldText: "line 10", newText: "line 10 changed" }] }, theme, ctx1);
		// Let the first compute resolve and paint the preview. The resolution
		// callback only updates `component.preview`; re-run renderCall (as the
		// real TUI does via context.invalidate -> updateDisplay -> renderCall) so
		// the rendered body reflects it.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const ctx1b = makeContext(state, { lastComponent: state.callComponent });
		def.renderCall?.({ path: filePath, edits: [{ oldText: "line 10", newText: "line 10 changed" }] }, theme, ctx1b);

		const firstComponent = state.callComponent as Box;
		const firstRender = stripAnsi(firstComponent.render(80).join("\n"));
		expect(firstRender).toContain("line 10 changed");

		// New chunk arrives immediately after (within the throttle window) — the
		// dispatch is deferred, but the previous preview must still be visible
		// rather than clearing to an empty body.
		const ctx2 = makeContext(state, { lastComponent: state.callComponent });
		def.renderCall?.(
			{ path: filePath, edits: [{ oldText: "line 10", newText: "line 10 changed more" }] },
			theme,
			ctx2,
		);

		const secondComponent = state.callComponent as Box;
		const secondRender = stripAnsi(secondComponent.render(80).join("\n"));
		expect(secondRender).toContain("line 10 changed");
	});
});
