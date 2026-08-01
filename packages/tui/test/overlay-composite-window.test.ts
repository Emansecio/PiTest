import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
	takeWrites(): string {
		const joined = this.writes.join("");
		this.writes.length = 0;
		return joined;
	}
}

class LinesComponent implements Component {
	lines: string[] = [];
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

// Golden output captured from the PRE-fix compositeOverlays (full `[...lines]`
// copy + padding per frame) on this exact scenario. The windowed rewrite
// (compose only over [viewportStart, workingHeight), reuse the untouched
// prefix) must stay byte-identical — both in what lands on the emulated screen
// and in the raw escape stream written per frame.
const GOLDEN_VIEWPORTS: string[][] = [
	[
		"transcript-20",
		"transcript-21",
		"transcript-22",
		"transcriptOV-A                          ",
		"transcriptOV-B                          ",
		"transcriptOV-C-longer                   ",
		"transcript-26",
		"transcript-27",
		"transcript-28",
		"transcript-29",
	],
	[
		"transcript-21",
		"transcript-22",
		"transcript-23",
		"transcriptOV-A                          ",
		"transcriptOV-B2                         ",
		"transcriptOV-C-longer                   ",
		"transcript-27",
		"transcript-28",
		"transcript-29",
		"transcript-30",
	],
	[
		"transcript-21",
		"transcript-22",
		"transcript-23",
		"transcriptOV-A                          ",
		"transcriptOV-B3                         ",
		"transcriptOV-C-longer                   ",
		"transcript-27",
		"transcript-28",
		"transcript-29",
		"transcript-30",
	],
	[
		"transcript-21",
		"transcript-22",
		"transcript-23",
		"transcript-24",
		"transcript-25-red",
		"transcript-26",
		"transcript-27",
		"transcript-28",
		"transcript-29",
		"transcript-30",
	],
];

// Raw per-frame write streams for the frames AFTER the initial paint (the
// startup frame includes capability queries, kept out of the golden so the
// assertion does not depend on terminal-detection environment).
const GOLDEN_WRITES: string[] = [
	// frame 2: transcript grew by one line AND the overlay changed
	"\u001b[?2026h\u001b[6A\r\u001b[2Ktranscript-23\u001b[0m\u001b]8;;\u0007\r\n\u001b[2Ktranscript\u001b[0m\u001b]8;;\u0007OV-A                \u001b[0m\u001b]8;;\u0007          \u001b[0m\u001b]8;;\u0007\r\n\u001b[2K\u001b[31mtranscript\u001b[0m\u001b]8;;\u0007\u001b[32mOV-B2\u001b[0m               \u001b[0m\u001b]8;;\u0007          \u001b[0m\u001b]8;;\u0007\r\n\u001b[2Ktranscript\u001b[0m\u001b]8;;\u0007OV-C-longer         \u001b[0m\u001b]8;;\u0007          \u001b[0m\u001b]8;;\u0007\r\n\u001b[2Ktranscript-27\u001b[0m\u001b]8;;\u0007\r\n\u001b[2Ktranscript-28\u001b[0m\u001b]8;;\u0007\r\n\u001b[2Ktranscript-29\u001b[0m\u001b]8;;\u0007\r\n\u001b[2Ktranscript-30\u001b[0m\u001b]8;;\u0007\u001b[?2026l",
	// frame 3: overlay-only change (transcript flatten identity stable) — the
	// windowed composite must still produce a single-row diff, nothing more
	"\u001b[?2026h\u001b[5A\r\u001b[2K\u001b[31mtranscript\u001b[0m\u001b]8;;\u0007\u001b[32mOV-B3\u001b[0m               \u001b[0m\u001b]8;;\u0007          \u001b[0m\u001b]8;;\u0007\u001b[?2026l",
	// frame 4: overlay closed — base rows restored
	"\u001b[?2026h\u001b[1A\r\u001b[2Ktranscript-24\u001b[0m\u001b]8;;\u0007\r\n\u001b[2K\u001b[31mtranscript-25-red\u001b[0m\u001b[0m\u001b]8;;\u0007\r\n\u001b[2Ktranscript-26\u001b[0m\u001b]8;;\u0007\u001b[?2026l",
];

describe("compositeOverlays windowed rewrite", () => {
	it("stays byte-identical to the full-copy compositor on a fixed scenario", async () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TUI(terminal);

		const transcript = new LinesComponent();
		transcript.lines = Array.from({ length: 30 }, (_, i) => `transcript-${String(i).padStart(2, "0")}`);
		transcript.lines[25] = "\x1b[31mtranscript-25-red\x1b[0m";
		tui.addChild(transcript);

		const overlay = new LinesComponent();
		overlay.lines = ["OV-A", "\x1b[32mOV-B\x1b[0m", "OV-C-longer"];
		const handle = tui.showOverlay(overlay, { width: 20, anchor: "center" });

		tui.start();
		await terminal.waitForRender();
		assert.deepEqual(await terminal.flushAndGetViewport(), GOLDEN_VIEWPORTS[0]);
		terminal.takeWrites(); // discard startup frame (capability queries + full paint)

		// frame 2: transcript grows (new flatten identity → prefix recopy path)
		// AND the overlay changes.
		transcript.lines = [...transcript.lines, "transcript-30"];
		overlay.lines = ["OV-A", "\x1b[32mOV-B2\x1b[0m", "OV-C-longer"];
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepEqual(await terminal.flushAndGetViewport(), GOLDEN_VIEWPORTS[1]);
		assert.equal(terminal.takeWrites(), GOLDEN_WRITES[0]);

		// frame 3: only the overlay changes (transcript identity stable → the
		// prefix-reuse path with zero transcript copying).
		overlay.lines = ["OV-A", "\x1b[32mOV-B3\x1b[0m", "OV-C-longer"];
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepEqual(await terminal.flushAndGetViewport(), GOLDEN_VIEWPORTS[2]);
		assert.equal(terminal.takeWrites(), GOLDEN_WRITES[1]);

		// frame 4: overlay closed — base content must reappear untouched.
		handle.hide();
		await terminal.waitForRender();
		assert.deepEqual(await terminal.flushAndGetViewport(), GOLDEN_VIEWPORTS[3]);
		assert.equal(terminal.takeWrites(), GOLDEN_WRITES[2]);

		tui.stop();
	});

	it("keeps a static overlay frame a no-op (no writes) when nothing changes", async () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TUI(terminal);
		const transcript = new LinesComponent();
		transcript.lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
		tui.addChild(transcript);
		const overlay = new LinesComponent();
		overlay.lines = ["POPUP"];
		tui.showOverlay(overlay, { width: 10 });

		tui.start();
		await terminal.waitForRender();
		terminal.takeWrites();

		// Re-render with identical content: the reused composite buffer must
		// yield value-identical lines so the diff emits nothing at all.
		tui.requestRender();
		await terminal.waitForRender();
		assert.equal(terminal.takeWrites(), "", "an unchanged overlay frame must not write a single byte");

		const viewport = await terminal.flushAndGetViewport();
		assert.ok(
			viewport.some((line) => line.includes("POPUP")),
			"overlay still visible",
		);

		tui.stop();
	});

	it("recomposites correctly when the overlay grows past the previous working height", async () => {
		const terminal = new RecordingTerminal(30, 8);
		const tui = new TUI(terminal);
		const transcript = new LinesComponent();
		transcript.lines = ["only-line"];
		tui.addChild(transcript);
		const overlay = new LinesComponent();
		overlay.lines = ["one"];
		tui.showOverlay(overlay, { width: 10, anchor: "bottom-left" });

		tui.start();
		await terminal.waitForRender();
		let viewport = await terminal.flushAndGetViewport();
		assert.ok(viewport[7]!.startsWith("one"), `expected bottom-anchored overlay, got ${JSON.stringify(viewport)}`);

		overlay.lines = ["one", "two", "three"];
		tui.requestRender();
		await terminal.waitForRender();
		viewport = await terminal.flushAndGetViewport();
		assert.ok(viewport[5]!.startsWith("one"), `got ${JSON.stringify(viewport)}`);
		assert.ok(viewport[6]!.startsWith("two"), `got ${JSON.stringify(viewport)}`);
		assert.ok(viewport[7]!.startsWith("three"), `got ${JSON.stringify(viewport)}`);

		tui.stop();
	});
});
