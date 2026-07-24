import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

/**
 * Guards for the out-of-band CURSOR_MARKER strip.
 *
 * extractCursorPosition used to return a full marker-stripped copy of the frame
 * (an O(total lines) pass on every focused frame — i.e. every frame, since the
 * editor holds focus while a spinner ticks at ~60fps). It now returns only
 * (row, replacement) and applyLineResets applies the one-line edit while filling
 * the output buffer it already builds. These tests pin both halves: the painted
 * result must be identical to a frame whose component emitted the stripped line
 * itself, and the strip must not touch anything outside the visible viewport.
 */

class LinesComponent implements Component {
	lines: string[] = [];
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

/** VirtualTerminal that also keeps the raw byte stream, for marker-leak assertions. */
class RecordingTerminal extends VirtualTerminal {
	private chunks: string[] = [];

	override write(data: string): void {
		this.chunks.push(data);
		super.write(data);
	}

	recorded(): string {
		return this.chunks.join("");
	}
}

/** Force a synchronous render, bypassing the throttled scheduler. */
function render(tui: TUI): void {
	(tui as unknown as { doRender(): void }).doRender();
}

type CursorStrip = { pos: { row: number; col: number } | null; strippedRow: number; strippedLine: string };

function extractOf(tui: TUI): (lines: string[], height: number) => CursorStrip {
	return (
		tui as unknown as { extractCursorPosition(lines: string[], height: number): CursorStrip }
	).extractCursorPosition.bind(tui);
}

const ROWS = 10;
const COLS = 40;

/** Transcript longer than the viewport, so only its tail is on screen. */
function transcript(n: number): string[] {
	return Array.from({ length: n }, (_, i) => `line-${i}`);
}

describe("CURSOR_MARKER out-of-band strip", () => {
	it("paints the same screen as a component that emitted the stripped line itself", async () => {
		// Two identical sessions driven through identical frames; the only difference
		// is where the marker is removed (upstream in the component vs. out-of-band in
		// the render pipeline). The emulated cell grid is the real rendered output, so
		// comparing viewports is the byte-identity check that matters — raw streams
		// legitimately differ by the hardware-cursor movement escapes the marker
		// enables, which is the whole point of emitting it.
		const markerTerm = new VirtualTerminal(COLS, ROWS);
		const plainTerm = new VirtualTerminal(COLS, ROWS);
		const markerTui = new TUI(markerTerm);
		const plainTui = new TUI(plainTerm);
		const markerComp = new LinesComponent();
		const plainComp = new LinesComponent();
		markerTui.addChild(markerComp);
		plainTui.addChild(plainComp);

		const base = transcript(40);
		for (let tick = 0; tick < 4; tick++) {
			// Marker sits mid-line on the bottom row, exactly where the editor puts it.
			const head = `> input-${tick}`;
			const tail = "  <- rest";
			markerComp.lines = [...base, `${head}${CURSOR_MARKER}${tail}`];
			plainComp.lines = [...base, `${head}${tail}`];
			render(markerTui);
			render(plainTui);

			const withMarker = await markerTerm.flushAndGetViewport();
			const withoutMarker = await plainTerm.flushAndGetViewport();
			assert.deepEqual(withMarker, withoutMarker, `frame ${tick} must paint identically to the pre-stripped frame`);
		}
	});

	it("never writes the marker bytes to the terminal", () => {
		const terminal = new RecordingTerminal(COLS, ROWS);
		const tui = new TUI(terminal);
		const comp = new LinesComponent();
		tui.addChild(comp);

		comp.lines = [...transcript(30), `> typed${CURSOR_MARKER}`];
		render(tui);
		comp.lines = [...transcript(30), `> typed!${CURSOR_MARKER}`];
		render(tui);

		assert.ok(
			!terminal.recorded().includes(CURSOR_MARKER),
			"the marker must be stripped before reaching the terminal",
		);
		assert.ok(terminal.recorded().includes("> typed!"), "the stripped line must be written");
	});

	it("keeps painting correctly when the marker line is stable across frames", async () => {
		// Exercises applyLineResets' all-stable early return with a strip present: the
		// scan must compare the *stripped* line against the input cache, otherwise the
		// frame is treated as dirty forever (or, worse, the cache desyncs).
		const terminal = new VirtualTerminal(COLS, ROWS);
		const tui = new TUI(terminal);
		const comp = new LinesComponent();
		tui.addChild(comp);

		const base = transcript(20);
		comp.lines = [...base, `> steady${CURSOR_MARKER}`];
		render(tui);
		const first = await terminal.flushAndGetViewport();

		// Same content, fresh array (what a component reallocating its output does).
		comp.lines = [...base, `> steady${CURSOR_MARKER}`];
		render(tui);
		const second = await terminal.flushAndGetViewport();

		assert.deepEqual(second, first, "an unchanged frame must repaint to the same screen");
		assert.ok(
			first.some((l) => l.includes("> steady")),
			"the stripped input line must be visible",
		);
	});

	it("paints correctly when the marker is above the bottom line", async () => {
		const terminal = new VirtualTerminal(COLS, ROWS);
		const tui = new TUI(terminal);
		const comp = new LinesComponent();
		tui.addChild(comp);

		comp.lines = [...transcript(15), `> mid${CURSOR_MARKER}line`, "status bar"];
		render(tui);
		const viewport = await terminal.flushAndGetViewport();

		assert.ok(
			viewport.some((l) => l.includes("> midline")),
			`stripped line must be painted, got ${JSON.stringify(viewport)}`,
		);
	});

	it("never mutates the array handed in by the component", () => {
		const terminal = new VirtualTerminal(COLS, ROWS);
		const tui = new TUI(terminal);
		const comp = new LinesComponent();
		tui.addChild(comp);

		const source = [...transcript(30), `> typed${CURSOR_MARKER}`];
		comp.lines = source;
		render(tui);
		render(tui);

		// `lines` may be a Container's memoized flatten array; a strip that wrote
		// through would corrupt it (double-applied resets on the next frame).
		assert.ok(source.at(-1)?.includes(CURSOR_MARKER), "the source array must still carry the marker");
		assert.deepEqual(source, [...transcript(30), `> typed${CURSOR_MARKER}`]);
	});

	it("reports the marker's row and visual column, and the stripped replacement", () => {
		const tui = new TUI(new VirtualTerminal(COLS, ROWS));
		const extract = extractOf(tui);

		const lines = ["a", "b", `日本${CURSOR_MARKER}x`];
		const result = extract(lines, ROWS);

		assert.deepEqual(result.pos, { row: 2, col: 4 }, "wide chars before the marker count 2 columns each");
		assert.equal(result.strippedRow, 2);
		assert.equal(result.strippedLine, "日本x");
		// The scan runs bottom-up, so the lowest marker wins.
		const twoMarkers = [`top${CURSOR_MARKER}`, `bottom${CURSOR_MARKER}`];
		assert.equal(extract(twoMarkers, ROWS).strippedRow, 1);
	});

	it("reports no strip when there is no marker", () => {
		const tui = new TUI(new VirtualTerminal(COLS, ROWS));
		const result = extractOf(tui)(["plain", "lines"], ROWS);
		assert.equal(result.pos, null);
		assert.equal(result.strippedRow, -1, "-1 means 'nothing to replace'");
	});
});

describe("CURSOR_MARKER strip perf guard", () => {
	it("touches only the visible viewport, never the whole transcript", () => {
		// The regression this pins: a full-length copy of the frame on every focused
		// frame. Counting element access on the input array makes the cost visible
		// and independent of transcript length — a 20k-line session must do the same
		// work as a 200-line one.
		const tui = new TUI(new VirtualTerminal(COLS, ROWS));
		const extract = extractOf(tui);

		const measure = (n: number): { reads: number; writes: number } => {
			const raw = [...transcript(n - 1), `> typed${CURSOR_MARKER}`];
			let reads = 0;
			let writes = 0;
			const probe = new Proxy(raw, {
				get(target, prop, receiver) {
					if (typeof prop === "string" && /^\d+$/.test(prop)) reads += 1;
					return Reflect.get(target, prop, receiver);
				},
				set(target, prop, value, receiver) {
					writes += 1;
					return Reflect.set(target, prop, value, receiver);
				},
			});
			const result = extract(probe, ROWS);
			assert.equal(result.strippedRow, n - 1);
			return { reads, writes };
		};

		const small = measure(200);
		const large = measure(20000);

		assert.equal(small.writes, 0, "the input frame must never be written to");
		assert.equal(large.writes, 0, "the input frame must never be written to");
		assert.ok(large.reads <= ROWS, `expected at most ${ROWS} line reads (the viewport), got ${large.reads}`);
		assert.equal(
			large.reads,
			small.reads,
			`per-frame work must not scale with transcript length (200 lines: ${small.reads}, 20000 lines: ${large.reads})`,
		);
	});

	it("keeps the last-line-only diff fast path while the marker is present", () => {
		// End-to-end consequence of the strip staying out-of-band: a spinner tick on
		// the bottom line (with the editor focused, so the marker is there too) still
		// resolves via resetFirstDirty with zero prefix comparisons.
		const terminal = new VirtualTerminal(COLS, ROWS);
		const tui = new TUI(terminal);
		const comp = new LinesComponent();
		const base = transcript(300);
		tui.addChild(comp);

		comp.lines = [...base, `> typed${CURSOR_MARKER}`];
		render(tui);

		comp.lines = [...base, `> typed!${CURSOR_MARKER}`];
		render(tui);

		assert.equal(
			tui.getDiffScanCountForTest(),
			0,
			"a bottom-line change under a live cursor marker must skip the O(N) prefix scan",
		);
	});
});
