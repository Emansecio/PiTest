import { resetCapabilitiesCache, setCapabilities, type TUI } from "@pit/tui";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ActivityLineComponent } from "../src/modes/interactive/components/activity-line.ts";
import { NavGroupComponent } from "../src/modes/interactive/components/nav-group.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// Pin capabilities so the gutter/icon ColorEases never arm against the tracking
// TUI's animation loop (a truecolor host would, polluting the callback count).
beforeAll(() => {
	initTheme("dark");
	setCapabilities({ images: null, trueColor: false, hyperlinks: false });
});
afterAll(() => resetCapabilitiesCache());

/**
 * A TUI test double that actually models the animation loop: addAnimationCallback
 * registers the callback (returning a real unsubscribe that removes it) so the
 * number of live callbacks is observable. This is exactly how the leak manifests
 * — a ticker that is never stop()'d keeps a callback registered forever.
 */
function trackingTui(): { ui: TUI; active: () => number; tickAll: (now: number) => void } {
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
	return {
		ui,
		active: () => cbs.size,
		// Drive every live callback once; mirrors a TUI animation tick (a ticker
		// that reports "done" self-removes via the unsubscribe it captured).
		tickAll: (now: number) => {
			for (const fn of [...cbs]) fn(now);
		},
	};
}

function pendingExec(ui: TUI, name = "bash", args: any = { command: "npm test" }): ToolExecutionComponent {
	const c = new ToolExecutionComponent(name, "x1", args, {}, undefined, ui, process.cwd());
	c.markExecutionStarted();
	return c;
}

describe("ToolExecutionComponent.dispose stops its animations", () => {
	test("a running spinner registers a callback that dispose() removes", () => {
		const t = trackingTui();
		const c = pendingExec(t.ui);
		// Pending + execution started → render arms the gutter running spinner.
		c.render(120);
		expect(t.active()).toBeGreaterThan(0);
		c.dispose();
		expect(t.active()).toBe(0);
	});

	test("dispose is idempotent and a normal settle already releases the callback", () => {
		const t = trackingTui();
		const c = pendingExec(t.ui);
		c.render(120);
		expect(t.active()).toBeGreaterThan(0);
		// Normal completion path: settling stops the running spinner on its own.
		c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		c.render(120);
		expect(t.active()).toBe(0);
		// Calling dispose afterwards is a safe no-op.
		c.dispose();
		expect(t.active()).toBe(0);
	});
});

describe("ActivityLineComponent.dispose stops its ticker", () => {
	test("a pending action line arms a ticker that dispose() removes", () => {
		const t = trackingTui();
		const exec = pendingExec(t.ui);
		const line = new ActivityLineComponent(t.ui);
		line.setExec(exec); // pending → ensureTicker arms a spinner callback
		expect(t.active()).toBeGreaterThan(0);
		line.dispose();
		expect(t.active()).toBe(0);
	});

	test("ticker self-stops once the wrapped exec settles (no dispose needed)", () => {
		const t = trackingTui();
		const exec = pendingExec(t.ui);
		const line = new ActivityLineComponent(t.ui);
		line.setExec(exec);
		expect(t.active()).toBeGreaterThan(0);
		// Spin at least one frame while pending (so the ticker has something to
		// clear), then settle and tick again: createSpinnerTicker emits null and
		// self-stops, unregistering the callback. This is the normal runtime path.
		t.tickAll(0);
		exec.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		t.tickAll(1000);
		expect(t.active()).toBe(0);
	});
});

describe("NavGroupComponent.dispose stops its ticker and children", () => {
	test("a pending nav group arms a ticker that dispose() removes", () => {
		const t = trackingTui();
		const exec = new ToolExecutionComponent("read", "r1", { file_path: "a.ts" }, {}, undefined, t.ui, process.cwd());
		exec.markExecutionStarted();
		const group = new NavGroupComponent(t.ui);
		group.addCall(exec); // pending → ensureTicker arms a spinner callback
		expect(t.active()).toBeGreaterThan(0);
		group.dispose();
		expect(t.active()).toBe(0);
	});

	test("dispose cascades to wrapped execs (their own callbacks are gone too)", () => {
		const t = trackingTui();
		const a = new ToolExecutionComponent("read", "r1", { file_path: "a.ts" }, {}, undefined, t.ui, process.cwd());
		const b = new ToolExecutionComponent("read", "r2", { file_path: "b.ts" }, {}, undefined, t.ui, process.cwd());
		a.markExecutionStarted();
		b.markExecutionStarted();
		const group = new NavGroupComponent(t.ui);
		group.addCall(a);
		group.addCall(b);
		group.render(120);
		expect(t.active()).toBeGreaterThan(0);
		group.dispose();
		// Group ticker + both child execs' callbacks all removed.
		expect(t.active()).toBe(0);
	});
});

/**
 * Path (a) at the unit the fix lives on: a wrapped exec that is "settled as
 * incomplete" (what renderSessionContext does for a toolCall with no toolResult
 * on resume) flips the line/group out of pending so the ticker self-stops — no
 * orphaned callback survives the rebuild.
 */
describe("orphan resume settle stops the ticker", () => {
	test("settling an ActivityLine's exec as incomplete self-stops its ticker", () => {
		const t = trackingTui();
		const exec = pendingExec(t.ui);
		const line = new ActivityLineComponent(t.ui);
		line.setExec(exec);
		expect(t.active()).toBeGreaterThan(0);
		t.tickAll(0); // spin once while pending
		// Mirror renderSessionContext's settleOrphanTools branch.
		exec.updateResult({
			content: [{ type: "text", text: "(incompleto — sessão retomada)" }],
			isError: true,
		});
		t.tickAll(1000);
		expect(t.active()).toBe(0);
		expect(exec.getActivityState()).toBe("error");
	});

	test("settling a NavGroup's pending exec as incomplete self-stops the group ticker", () => {
		const t = trackingTui();
		const exec = new ToolExecutionComponent("read", "r1", { file_path: "a.ts" }, {}, undefined, t.ui, process.cwd());
		exec.markExecutionStarted();
		const group = new NavGroupComponent(t.ui);
		group.addCall(exec);
		expect(t.active()).toBeGreaterThan(0);
		t.tickAll(0); // spin once while pending
		exec.updateResult({
			content: [{ type: "text", text: "(incompleto — sessão retomada)" }],
			isError: true,
		});
		t.tickAll(1000);
		expect(t.active()).toBe(0);
	});
});
