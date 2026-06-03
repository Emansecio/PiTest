import assert from "node:assert";
import { describe, it } from "node:test";
import { encodeKitty } from "../src/terminal-image.js";
import { assertComponentWidth, type Component, setRenderAssertEnabled, TUI } from "../src/tui.js";
import { visibleWidth } from "../src/utils.js";
import { VirtualTerminal } from "./virtual-terminal.js";

async function renderAndFlush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
}

class FixedComponent implements Component {
	private readonly lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

describe("per-component render width assert", () => {
	it("does not throw when every line fits", () => {
		const comp = new FixedComponent(["ok", "also fine", ""]);
		assert.doesNotThrow(() => assertComponentWidth(comp, comp.render(20), 20));
	});

	it("throws naming the component and quoting the offending line", () => {
		const comp = new FixedComponent(["short", "x".repeat(50)]);
		assert.throws(
			() => assertComponentWidth(comp, comp.render(20), 20),
			(err: Error) => {
				assert.match(err.message, /FixedComponent/);
				assert.match(err.message, /line 1/); // the second line (index 1) is the culprit
				assert.match(err.message, /width 50 \(> 20\)/);
				return true;
			},
		);
	});

	it("measures visible width, ignoring SGR escape codes", () => {
		// 10 visible columns wrapped in color codes — fits in width 10, must not throw.
		const colored = `\x1b[38;2;1;2;3m${"a".repeat(10)}\x1b[39m`;
		const comp = new FixedComponent([colored]);
		assert.doesNotThrow(() => assertComponentWidth(comp, comp.render(10), 10));
	});

	it("skips Kitty image lines (their byte length is not visible width)", () => {
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 1, imageId: 1, moveCursor: false });
		const comp = new FixedComponent([imageLine]);
		assert.doesNotThrow(() => assertComponentWidth(comp, comp.render(5), 5));
	});

	it("fires at the Container boundary when enabled, and is silent when disabled", () => {
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TUI(terminal);
		tui.addChild(new FixedComponent(["x".repeat(40)]));

		try {
			setRenderAssertEnabled(false);
			assert.doesNotThrow(() => tui.render(20), "disabled: Container.render must not assert");

			setRenderAssertEnabled(true);
			assert.throws(() => tui.render(20), /TUI render assert: FixedComponent/, "enabled: must name the child");
		} finally {
			setRenderAssertEnabled(false);
		}
	});
});

describe("doRender last-resort width net (production)", () => {
	// The crash that motivated this: a component composed a line past the
	// terminal width and doRender threw an uncaughtException, killing the
	// session mid-task. With asserts off (production), it must instead truncate
	// the line and keep rendering. assertComponentWidth (above) stays the place
	// that catches the real culprit by name in dev/CI.
	it("truncates an over-wide line instead of crashing the session", async () => {
		setRenderAssertEnabled(false);
		const width = 80;
		const terminal = new VirtualTerminal(width, 24);
		const tui = new TUI(terminal);
		// 100 visible columns on an 80-col terminal — 20 past the edge.
		tui.addChild(new FixedComponent(["X".repeat(100)]));
		tui.start();
		try {
			// Must not throw / must not crash the process via the render timer.
			await renderAndFlush(tui, terminal);

			const viewport = terminal.getViewport();
			for (let i = 0; i < viewport.length; i++) {
				assert.ok(
					visibleWidth(viewport[i]) <= width,
					`viewport line ${i} width ${visibleWidth(viewport[i])} exceeds ${width}`,
				);
			}
			// Truncated, NOT wrapped: the content occupies exactly one visual row
			// (a naive non-truncating render would wrap 100 cols into 80 + 20, i.e.
			// two rows containing 'X') and carries the ellipsis marker.
			const contentRows = viewport.filter((l) => l.includes("X"));
			assert.strictEqual(contentRows.length, 1, "over-wide line must collapse to a single truncated row");
			assert.ok(contentRows[0].includes("…"), "truncated line should carry an ellipsis");
		} finally {
			tui.stop();
			setRenderAssertEnabled(false);
		}
	});
});
