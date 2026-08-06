import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	_registerBashBackgroundJobForTest,
	_resetBashBackgroundJobsForTest,
	type BashBackgroundJob,
} from "../src/core/tools/bash.ts";
import type { RunningWorkItem } from "../src/modes/interactive/components/running-work-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const proto = InteractiveMode.prototype as any;

function backgroundJob(id = "bg-1"): BashBackgroundJob {
	const now = Date.now();
	return {
		id,
		pid: undefined,
		command: "npm run build",
		startedAt: now - 2_000,
		promotedAt: now - 1_000,
		exited: false,
		exitCode: null,
		lastOutputAt: now,
		resultSeen: false,
		ringBuffer: "",
		ringTruncated: false,
		kill: () => {},
	};
}

beforeEach(() => _resetBashBackgroundJobsForTest());
afterEach(() => _resetBashBackgroundJobsForTest());

describe("InteractiveMode running-work bridge", () => {
	test("builds foreground command labels and live background rows", () => {
		const sessionId = "session-a";
		_registerBashBackgroundJobForTest({ ...backgroundJob(), ownerSessionId: sessionId });
		const fakeThis = {
			session: { sessionId },
			pendingTools: new Map([
				[
					"tool-1",
					{
						getToolName: () => "bash",
						getArgs: () => ({ command: "npm test\nignored" }),
					},
				],
				[
					"tool-2",
					{
						getToolName: () => "write",
						getArgs: () => ({ path: "should-not-be-cancellable.txt" }),
					},
				],
			]),
		};

		const items = proto.getRunningWorkItems.call(fakeThis) as RunningWorkItem[];

		expect(items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "foreground", id: "tool-1", label: "npm test" }),
				expect.objectContaining({ kind: "background", id: "bg-1", label: "npm run build" }),
			]),
		);
		expect(items).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "tool-2" })]));
	});

	test("foreground interruption cancels only that tool and keeps the turn alive", async () => {
		const cancelTool = vi.fn(() => true);
		const interrupt = vi.fn();
		const showStatus = vi.fn();
		await proto.interruptRunningWorkItem.call(
			{ session: { cancelTool, interrupt }, showStatus },
			{ kind: "foreground", id: "tool-1", label: "npm test", state: "running" },
		);

		expect(cancelTool).toHaveBeenCalledExactlyOnceWith("tool-1");
		expect(interrupt).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Interrupt requested for npm test; waiting for partial output");
	});

	test("setupKeyHandlers routes empty-composer Up through the running-work surface", () => {
		const editor: any = { onAction: vi.fn() };
		const showRunningWorkSelector = vi.fn(() => true);
		const fakeThis: any = {
			defaultEditor: editor,
			editor: { getText: () => "" },
			ui: { addInputListener: vi.fn(() => vi.fn()), onDebug: undefined },
			signalCleanupHandlers: [],
			session: { isBusy: false },
			showRunningWorkSelector,
			isBashMode: false,
		};

		proto.setupKeyHandlers.call(fakeThis);

		expect(editor.onNavigateToRunningWork).toBeTypeOf("function");
		expect(editor.onNavigateToRunningWork()).toBe(true);
		expect(showRunningWorkSelector).toHaveBeenCalledOnce();
	});
});
