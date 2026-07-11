import assert from "node:assert";
import * as fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class TestComponent implements Component {
	lines: string[] = ["hello debug"];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

describe("TUI PIT_TUI_DEBUG", () => {
	const previousDebug = process.env.PIT_TUI_DEBUG;
	const previousFull = process.env.PIT_TUI_DEBUG_FULL;

	afterEach(() => {
		if (previousDebug === undefined) delete process.env.PIT_TUI_DEBUG;
		else process.env.PIT_TUI_DEBUG = previousDebug;
		if (previousFull === undefined) delete process.env.PIT_TUI_DEBUG_FULL;
		else process.env.PIT_TUI_DEBUG_FULL = previousFull;
	});

	async function captureDifferentialDebugWrite(
		run: (args: { tui: TUI; component: TestComponent }) => Promise<void>,
	): Promise<string[]> {
		const writes: string[] = [];
		const originalWriteFile = fs.promises.writeFile;
		const originalMkdir = fs.promises.mkdir;
		(fs.promises as { mkdir: typeof fs.promises.mkdir }).mkdir = (async () => undefined) as typeof fs.promises.mkdir;
		(fs.promises as { writeFile: typeof fs.promises.writeFile }).writeFile = (async (
			_path: Parameters<typeof fs.promises.writeFile>[0],
			data: Parameters<typeof fs.promises.writeFile>[1],
		) => {
			writes.push(String(data));
		}) as typeof fs.promises.writeFile;

		try {
			const terminal = new VirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);
			tui.start();
			await terminal.waitForRender();
			// First paint uses fullRender (no PIT_TUI_DEBUG). Second paint hits differential path.
			await run({ tui, component });
			tui.requestRender();
			await terminal.waitForRender();
			await new Promise((r) => setTimeout(r, 30));
			tui.stop();
			return writes;
		} finally {
			fs.promises.writeFile = originalWriteFile;
			fs.promises.mkdir = originalMkdir;
		}
	}

	it("metadata-only path does not stringify full frame lines", async () => {
		process.env.PIT_TUI_DEBUG = "1";
		delete process.env.PIT_TUI_DEBUG_FULL;

		const writes = await captureDifferentialDebugWrite(async ({ component }) => {
			component.lines = ["hello debug", "line two"];
		});

		assert.ok(writes.length >= 1, `expected at least one debug write, got ${writes.length}`);
		const body = writes[0]!;
		assert.match(body, /newLines\.length:/);
		assert.match(body, /buffer\.length:/);
		assert.match(body, /firstChanged:/);
		assert.doesNotMatch(body, /=== newLines ===/);
		assert.doesNotMatch(body, /=== previousLines ===/);
		assert.doesNotMatch(body, /=== buffer ===/);
		assert.ok(!body.includes("hello debug"), "must not dump line contents");
	});

	it("FULL path includes frame dump without pretty-print indent", async () => {
		process.env.PIT_TUI_DEBUG = "1";
		process.env.PIT_TUI_DEBUG_FULL = "1";

		const writes = await captureDifferentialDebugWrite(async ({ component }) => {
			component.lines = ["hello debug", "line two"];
		});

		assert.ok(writes.length >= 1, `expected at least one debug write, got ${writes.length}`);
		const body = writes[0]!;
		assert.match(body, /=== newLines ===/);
		assert.match(body, /=== buffer ===/);
		assert.ok(body.includes("hello debug"), "full dump should include line text");
		// Pretty-print uses indented newlines after `[`; compact stringify does not.
		assert.doesNotMatch(body, /\[\n\s+"/);
	});
});
