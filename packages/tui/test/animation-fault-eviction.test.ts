import assert from "node:assert";
import { describe, it } from "node:test";
import { type AnimationFrameCallback, type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

// Reach the private per-frame ticker and callback set so the test is
// deterministic instead of racing the real 16ms setInterval. Mirrors the
// `as unknown as` casts used in tui-animation-isolation.test.ts.
type TickableTUI = { tickAnimations(): void };
type AnimationInspectableTUI = TickableTUI & { animationCallbacks: Set<AnimationFrameCallback> };

describe("TUI animation fault eviction", () => {
	it("evicts a callback after 5 consecutive throws, leaving other callbacks unaffected", () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.addChild(new TestComponent());

		let saneCalls = 0;
		let brokenCalls = 0;
		const sane: AnimationFrameCallback = () => {
			saneCalls++;
			return false;
		};
		const broken: AnimationFrameCallback = () => {
			brokenCalls++;
			throw new Error("persistent boom");
		};

		tui.addAnimationCallback(sane);
		tui.addAnimationCallback(broken);

		const tick = () => (tui as unknown as TickableTUI).tickAnimations();

		try {
			for (let i = 1; i <= 8; i++) {
				assert.doesNotThrow(tick, `tick ${i} must not escape tickAnimations`);
			}

			// The broken callback throws on every tick up through the 5th
			// consecutive failure (which triggers eviction), then is never
			// invoked again — so its call count freezes at 5.
			assert.strictEqual(brokenCalls, 5, "broken callback is evicted after its 5th consecutive throw");
			// The sane callback keeps running on every tick, unaffected by its
			// sibling's eviction.
			assert.strictEqual(saneCalls, 8, "sane callback keeps ticking every frame");

			const internals = tui as unknown as AnimationInspectableTUI;
			assert.strictEqual(internals.animationCallbacks.has(broken), false, "evicted callback removed from the set");
			assert.strictEqual(internals.animationCallbacks.has(sane), true, "sane callback remains registered");
		} finally {
			tui.stop();
		}
	});

	it("resets the failure streak on a successful tick, so an intermittent thrower is not evicted", () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.addChild(new TestComponent());

		let calls = 0;
		const intermittent: AnimationFrameCallback = () => {
			calls++;
			// Throws 4 times in a row (below the 5-throw eviction threshold),
			// then succeeds — the consecutive-failure counter must reset to 0
			// rather than carrying over into a later streak.
			if (calls <= 4) throw new Error(`boom ${calls}`);
			return false;
		};

		tui.addAnimationCallback(intermittent);
		const tick = () => (tui as unknown as TickableTUI).tickAnimations();

		try {
			for (let i = 0; i < 4; i++) tick();
			tick(); // 5th call: succeeds, resets the streak to 0

			const internals = tui as unknown as AnimationInspectableTUI;
			assert.strictEqual(
				internals.animationCallbacks.has(intermittent),
				true,
				"callback survives because it never reached 5 CONSECUTIVE failures",
			);

			// Drive several more successful ticks — if eviction had incorrectly
			// fired, the callback would already be gone and calls would stop
			// incrementing.
			for (let i = 0; i < 3; i++) tick();
			assert.strictEqual(calls, 8, "callback keeps ticking after its streak was reset by a success");
		} finally {
			tui.stop();
		}
	});

	it("clears registered animation callbacks on stop()", () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.addChild(new TestComponent());

		let calls = 0;
		const callback: AnimationFrameCallback = () => {
			calls++;
			return false;
		};

		tui.addAnimationCallback(callback);
		const internals = tui as unknown as AnimationInspectableTUI;
		assert.strictEqual(internals.animationCallbacks.size, 1, "callback registered before stop()");

		tui.stop();

		assert.strictEqual(internals.animationCallbacks.size, 0, "stop() discards registered animation callbacks");

		// A manual tick after stop() must not resurrect the discarded callback.
		(tui as unknown as TickableTUI).tickAnimations();
		assert.strictEqual(calls, 0, "a stale callback is never invoked after stop()");
	});
});
