import { SPINNER_FRAME_MS, type TUI } from "@pit/tui";
import { describe, expect, test } from "vitest";
import type { GoalSnapshot } from "../src/core/goal/goal-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function activeGoal(): GoalSnapshot {
	return {
		id: "g1",
		objective: "ship it",
		status: "active",
		tokensUsed: 0,
		iterations: 0,
		startedAt: 0,
		elapsedMs: 0,
	};
}

/**
 * TUI double whose animation loop is observable. Mirrors tickAnimations():
 * a render is requested only when some callback returns true.
 */
function trackingTui(): {
	ui: TUI;
	active: () => number;
	tickAnimations: (now: number) => number;
} {
	const cbs = new Set<(now: number) => boolean>();
	let renders = 0;
	const ui = {
		requestRender() {
			renders += 1;
		},
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
		tickAnimations: (now: number) => {
			let dirty = 0;
			for (const fn of [...cbs]) {
				if (fn(now)) dirty += 1;
			}
			if (dirty > 0) renders += 1;
			return renders;
		},
	};
}

function goalSpinnerHarness(status: GoalSnapshot["status"] = "active") {
	const t = trackingTui();
	const snap = { ...activeGoal(), status };
	const start = Reflect.get(InteractiveMode.prototype, "_startGoalSpinner") as (this: GoalSpinnerFakeThis) => void;
	const stop = Reflect.get(InteractiveMode.prototype, "_stopGoalSpinner") as (this: GoalSpinnerFakeThis) => void;
	const fakeThis: GoalSpinnerFakeThis = {
		ui: t.ui,
		session: { goalSnapshot: () => snap },
		_goalSpinnerUnsub: undefined,
		_goalSpinnerBucket: -1,
		_stopGoalSpinner: stop,
	};
	return { t, fakeThis, snap, start, stop };
}

interface GoalSpinnerFakeThis {
	ui: TUI;
	session: { goalSnapshot: () => GoalSnapshot };
	_goalSpinnerUnsub: (() => void) | undefined;
	_goalSpinnerBucket: number;
	_stopGoalSpinner: (this: GoalSpinnerFakeThis) => void;
}

describe("_startGoalSpinner (#B)", () => {
	test("registers a callback only while goal status is active", () => {
		const { t, fakeThis, snap, start } = goalSpinnerHarness("paused");
		start.call(fakeThis);
		expect(t.active()).toBe(0);

		snap.status = "active";
		start.call(fakeThis);
		expect(t.active()).toBe(1);
	});

	test("is idempotent — second start does not register a duplicate callback", () => {
		const { t, fakeThis, start } = goalSpinnerHarness();
		start.call(fakeThis);
		start.call(fakeThis);
		expect(t.active()).toBe(1);
	});

	test("requests a render only when the 80ms spinner bucket advances", () => {
		const { t, fakeThis, start } = goalSpinnerHarness();
		start.call(fakeThis);

		t.tickAnimations(0);
		const afterFirst = t.tickAnimations(0);
		expect(afterFirst).toBe(1);

		const sameBucket = t.tickAnimations(40);
		expect(sameBucket).toBe(1);

		const nextBucket = t.tickAnimations(SPINNER_FRAME_MS);
		expect(nextBucket).toBe(2);
	});

	test("unsubscribes when goal is no longer active", () => {
		const { t, fakeThis, snap, start } = goalSpinnerHarness();
		start.call(fakeThis);
		expect(t.active()).toBe(1);

		snap.status = "paused";
		t.tickAnimations(SPINNER_FRAME_MS);
		expect(t.active()).toBe(0);
		expect(fakeThis._goalSpinnerUnsub).toBeUndefined();
	});

	test("stop() clears the subscription", () => {
		const { t, fakeThis, start, stop } = goalSpinnerHarness();
		start.call(fakeThis);
		stop.call(fakeThis);
		expect(t.active()).toBe(0);
		expect(fakeThis._goalSpinnerUnsub).toBeUndefined();
	});
});
