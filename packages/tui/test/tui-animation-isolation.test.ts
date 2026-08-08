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

// Reach the private per-frame ticker so the test is deterministic instead of
// racing the real 16ms setInterval. Mirrors the `as unknown as` casts the rest
// of the tui suite uses to inspect internals.
type TickableTUI = { tickAnimations(): void };
type AnimationInspectableTUI = TickableTUI & { animationCallbacks: Set<AnimationFrameCallback> };

describe("TUI animation callback isolation", () => {
	it("a throwing callback does not crash the tick and the others still run", () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.addChild(new TestComponent());

		const calls: string[] = [];
		const first: AnimationFrameCallback = () => {
			calls.push("first");
			return false;
		};
		const middle: AnimationFrameCallback = () => {
			calls.push("middle");
			throw new Error("boom");
		};
		const last: AnimationFrameCallback = () => {
			calls.push("last");
			return false;
		};

		// Registration order is also invocation order (Set preserves insertion).
		tui.addAnimationCallback(first);
		tui.addAnimationCallback(middle);
		tui.addAnimationCallback(last);

		const tick = () => (tui as unknown as TickableTUI).tickAnimations();

		// The throw must be contained, not propagated out of the tick.
		assert.doesNotThrow(tick, "a faulty callback must not escape tickAnimations");
		assert.deepStrictEqual(calls, ["first", "middle", "last"], "all three ran in order despite the throw");

		// A subsequent tick keeps working — the loop was not disabled.
		calls.length = 0;
		assert.doesNotThrow(tick, "the loop keeps running after a throwing tick");
		assert.deepStrictEqual(calls, ["first", "middle", "last"], "the next tick still drives every callback");

		tui.stop();
	});

	it("honors an explicitly slower callback cadence", () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		let calls = 0;
		tui.addAnimationCallback(() => {
			calls++;
			return false;
		}, 1000);

		const tick = () => (tui as unknown as TickableTUI).tickAnimations();
		tick();
		tick();
		assert.equal(calls, 1, "back-to-back shared ticks must not invoke a one-second callback twice");
		tui.stop();
	});

	it("renders a transient diagnostic when an animation callback throws", async () => {
		const terminal = new VirtualTerminal(60, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = ["ok"];
		tui.addChild(component);

		tui.start();
		try {
			await terminal.waitForRender();

			const internals = tui as unknown as AnimationInspectableTUI;
			internals.animationCallbacks.add(() => {
				throw new Error("spin boom");
			});
			internals.tickAnimations();
			await terminal.waitForRender();

			const viewport = terminal.getViewport();
			assert.ok(
				viewport.some((line) => line.includes("! animation error: spin boom")),
				`animation diagnostic rendered: ${JSON.stringify(viewport)}`,
			);
		} finally {
			tui.stop();
		}
	});
});
