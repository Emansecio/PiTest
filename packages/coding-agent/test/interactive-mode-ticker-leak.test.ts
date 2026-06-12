import { resetCapabilitiesCache, setCapabilities, type TUI } from "@pit/tui";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// Pin capabilities so the gutter ColorEase never arms against the tracking TUI.
beforeAll(() => {
	initTheme("dark");
	setCapabilities({ images: null, trueColor: false, hyperlinks: false });
});
afterAll(() => resetCapabilitiesCache());

/** TUI double whose animation loop is observable (see activity-ticker-leak.test). */
function trackingTui(): { ui: TUI; active: () => number } {
	const cbs = new Set<(now: number) => boolean>();
	const ui = {
		requestRender() {},
		addAnimationCallback(fn: (now: number) => boolean) {
			cbs.add(fn);
			return () => {
				cbs.delete(fn);
			};
		},
	} as unknown as TUI;
	return { ui, active: () => cbs.size };
}

describe("rebuildChatFromMessages tears down before clearing", () => {
	test("disposes live chat components before chatContainer.clear()", () => {
		const order: string[] = [];
		const disposed = { a: false, b: false };
		const fakeThis = {
			chatContainer: {
				children: [
					{
						dispose: () => {
							disposed.a = true;
							order.push("dispose");
						},
					},
					{
						dispose: () => {
							disposed.b = true;
							order.push("dispose");
						},
					},
				],
				clear: () => order.push("clear"),
			},
			sessionManager: { buildSessionContext: () => ({ messages: [] }) },
			renderSessionContext: () => order.push("render"),
			// Wire the real private teardown helper (rebuildChatFromMessages calls
			// this.\_disposeChatComponents()): it must walk children before the clear.
			_disposeChatComponents: Reflect.get(InteractiveMode.prototype, "_disposeChatComponents") as () => void,
		};

		const rebuild = Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages") as (
			this: typeof fakeThis,
		) => void;
		rebuild.call(fakeThis);

		// Every child disposed, and all disposes happen strictly before the clear
		// (clearing first would empty children and orphan their tickers).
		expect(disposed).toEqual({ a: true, b: true });
		expect(order).toEqual(["dispose", "dispose", "clear", "render"]);
	});
});

describe("renderSessionContext orphan-tool handling (resume path)", () => {
	function baseThis(ui: TUI, settle: boolean) {
		return {
			pendingTools: new Map<string, ToolExecutionComponent>(),
			settingsManager: {
				getToolActivity: () => "legacy", // non-grouped: exec is a direct child
				getShowImages: () => false,
				getImageWidthCells: () => 60,
			},
			activityStacker: { reset: vi.fn(), divide: vi.fn(), placeCall: vi.fn() },
			hideThinkingBlock: false,
			toolOutputExpanded: false,
			addMessageToChat: vi.fn(),
			getRegisteredToolDefinition: () => undefined,
			ui,
			sessionManager: { getCwd: () => process.cwd() },
			session: { retryAttempt: 0 },
			_abortedErrorMessage: () => "aborted",
			refreshModelIndicators: vi.fn(),
			chatContainer: { addChild: vi.fn() },
			settle,
		};
	}

	// A toolCall persisted without a matching toolResult — the exact JSONL shape
	// of a process that died mid-tool.
	const orphanContext = {
		messages: [
			{
				role: "assistant",
				stopReason: "end_turn",
				content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "sleep 999" } }],
			},
		],
	};

	test("settleOrphanTools: settles the orphan as incomplete, leaves pendingTools empty, no live ticker", () => {
		const t = trackingTui();
		const fakeThis = baseThis(t.ui, true);
		const render = Reflect.get(InteractiveMode.prototype, "renderSessionContext") as (
			this: typeof fakeThis,
			ctx: unknown,
			opts: { settleOrphanTools?: boolean },
		) => void;

		render.call(fakeThis, orphanContext, { settleOrphanTools: true });

		// The orphan is NOT left pending …
		expect(fakeThis.pendingTools.size).toBe(0);
		// … it is settled to an error state, and the captured row was added to chat.
		const added = fakeThis.chatContainer.addChild as ReturnType<typeof vi.fn>;
		expect(added).toHaveBeenCalledTimes(1);
		const exec = added.mock.calls[0][0] as ToolExecutionComponent;
		expect(exec.getActivityState()).toBe("error");
		// No spinner ticker survived (the leak): even after a render pass there is
		// no registered animation callback, because the row settled.
		exec.render(120);
		expect(t.active()).toBe(0);
	});

	test("without settleOrphanTools (live path): the orphan stays pending for the loop", () => {
		const t = trackingTui();
		const fakeThis = baseThis(t.ui, false);
		const render = Reflect.get(InteractiveMode.prototype, "renderSessionContext") as (
			this: typeof fakeThis,
			ctx: unknown,
			opts: { settleOrphanTools?: boolean },
		) => void;

		render.call(fakeThis, orphanContext, {});

		// Live rebuild keeps the pending row so tool_execution_end can still settle
		// it — behavior is unchanged on this path.
		expect(fakeThis.pendingTools.size).toBe(1);
		const exec = fakeThis.pendingTools.get("tc1")!;
		expect(exec.getActivityState()).toBe("pending");
	});
});
