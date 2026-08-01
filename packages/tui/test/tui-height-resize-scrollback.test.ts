import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.js";
import { Container, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

/**
 * A height-only resize repaints via fullRender("screen"): clear the visible
 * screen, KEEP the scrollback (same width → same wrap → the rolled-up history
 * is still valid). Reprinting ALL lines there rolled the 19.9xx lines above the
 * viewport into the scrollback AGAIN — duplicating the transcript history on
 * every vertical resize. The fix reprints only the tail that lands on the
 * physical screen; these tests pin both the non-duplication and the integrity
 * of the differential baseline afterwards.
 *
 * The "screen" path is reached when a render observes a new terminal height
 * before the resize callback runs — exactly what happens in real sessions,
 * where ProcessTerminal debounces SIGWINCH but process.stdout.rows updates
 * immediately (an animation tick mid-drag renders inside that window). We
 * reproduce it with resizeWithoutNotify + a direct render.
 */

function doRender(tui: TUI): void {
	(tui as unknown as { doRender(): void }).doRender();
}

function buildTranscript(count: number): { chat: Container; lines: Text[] } {
	const chat = new Container();
	const lines: Text[] = [];
	for (let i = 0; i < count; i++) {
		const text = new Text(`transcript-${String(i).padStart(3, "0")}`, 0, 0);
		lines.push(text);
		chat.addChild(text);
	}
	return { chat, lines };
}

function countMatching(buffer: string[], needle: string): number {
	return buffer.filter((line) => line.includes(needle)).length;
}

function assertNoDuplicates(buffer: string[]): void {
	const transcriptLines = buffer.map((l) => l.trimEnd()).filter((l) => l.startsWith("transcript-"));
	const unique = new Set(transcriptLines);
	assert.equal(
		transcriptLines.length,
		unique.size,
		`transcript lines duplicated in the terminal buffer: ${transcriptLines.length} lines, ${unique.size} unique`,
	);
}

describe("TUI height-only resize keeps the scrollback single-copy", () => {
	it("shrinking the height does not roll the transcript into the scrollback again", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const { chat } = buildTranscript(100);
		tui.addChild(chat);

		doRender(tui);
		await terminal.flush();
		assert.equal(countMatching(terminal.getScrollBuffer(), "transcript-010"), 1);

		// Height-only shrink observed by a render before the resize callback runs.
		terminal.resizeWithoutNotify(80, 20);
		doRender(tui);
		await terminal.flush();

		const buffer = terminal.getScrollBuffer();
		assert.equal(countMatching(buffer, "transcript-010"), 1, "history above the viewport must not be reprinted");
		assert.equal(countMatching(buffer, "transcript-099"), 1, "the visible tail is painted exactly once");
		assertNoDuplicates(buffer);

		// The physical viewport holds exactly the tail that fits the new height.
		const viewport = terminal.getViewport();
		assert.ok(viewport[0].includes("transcript-080"), `viewport top should be transcript-080, got "${viewport[0]}"`);
		assert.ok(
			viewport[19].includes("transcript-099"),
			`viewport bottom should be transcript-099, got "${viewport[19]}"`,
		);
	});

	it("growing the height does not duplicate the transcript either", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const { chat } = buildTranscript(100);
		tui.addChild(chat);

		doRender(tui);
		await terminal.flush();

		terminal.resizeWithoutNotify(80, 30);
		doRender(tui);
		await terminal.flush();

		const buffer = terminal.getScrollBuffer();
		assert.equal(countMatching(buffer, "transcript-010"), 1);
		assert.equal(countMatching(buffer, "transcript-099"), 1);
		assertNoDuplicates(buffer);

		const viewport = terminal.getViewport();
		assert.ok(viewport[0].includes("transcript-070"), `viewport top should be transcript-070, got "${viewport[0]}"`);
		assert.ok(
			viewport[29].includes("transcript-099"),
			`viewport bottom should be transcript-099, got "${viewport[29]}"`,
		);
	});

	it("the differential baseline stays valid after the tail-only repaint", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const { chat, lines } = buildTranscript(100);
		tui.addChild(chat);

		doRender(tui);
		await terminal.flush();

		terminal.resizeWithoutNotify(80, 20);
		doRender(tui);
		await terminal.flush();

		// Next frame is differential: previousLines committed the FULL 100 lines
		// even though only 20 were physically painted. Editing the last line must
		// repaint it in place — no duplication, no misplaced rows.
		lines[99].setText("transcript-099 EDITED");
		doRender(tui);
		await terminal.flush();

		const buffer = terminal.getScrollBuffer();
		assert.equal(countMatching(buffer, "EDITED"), 1, "the edited line lands exactly once");
		assert.equal(countMatching(buffer, "transcript-098"), 1, "neighbours are untouched");
		assertNoDuplicates(buffer);

		const viewport = terminal.getViewport();
		assert.ok(
			viewport[19].includes("transcript-099 EDITED"),
			`bottom row should show the edit, got "${viewport[19]}"`,
		);
		assert.ok(viewport[0].includes("transcript-080"), `viewport top unchanged, got "${viewport[0]}"`);
	});
});
