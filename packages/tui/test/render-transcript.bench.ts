/**
 * Render hot-path micro-bench (observational; NOT part of the test suite — the
 * suite globs test/*.test.ts, this is a *.bench.ts run via `npm run bench:render`).
 *
 * Reproduces the steady-state cost the spinner pays during a turn: a transcript
 * of N components stays live in the tree (the real chatContainer never flushes
 * to scrollback), and one bottom line changes per frame. Each frame re-runs the
 * full pipeline — flatten → applyLineResets → diff → Kitty scan — so the per-frame
 * cost scales with N. Records a baseline to catch regressions in tui.ts and
 * demonstrates the two applied wins:
 *
 *   #1 Kitty scan gate  → compare "gated" (non-Kitty caps) vs "scan" (Kitty caps,
 *                         which forces the per-line indexOf over every line).
 *   #2 reset-cache cap  → "cache" column reports the live cache size; once N>4096
 *                         a fixed cap would thrash to 0% hits (huge per-frame jump).
 */
import { performance } from "node:perf_hooks";
import { SPINNER_FRAMES } from "../src/components/loader.js";
import { Text } from "../src/components/text.js";
import type { Terminal } from "../src/terminal.js";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.js";
import { Container, TUI } from "../src/tui.js";

class NullTerminal implements Terminal {
	bytes = 0;
	private cols: number;
	private rowsCount: number;
	constructor(cols = 100, rowsCount = 40) {
		this.cols = cols;
		this.rowsCount = rowsCount;
	}
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.bytes += data.length;
	}
	get columns(): number {
		return this.cols;
	}
	get rows(): number {
		return this.rowsCount;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

function doRender(tui: TUI): void {
	(tui as unknown as { doRender(): void }).doRender();
}

const FRAMES = 300;
const SIZES = [500, 2000, 5000, 8000];

/** Build a TUI whose transcript holds N text lines plus a mutable spinner line. */
function build(n: number): { tui: TUI; spinner: Text } {
	const tui = new TUI(new NullTerminal());
	const chat = new Container();
	for (let i = 0; i < n; i++) {
		chat.addChild(new Text(`line ${i}: the quick brown fox jumps over the lazy dog ${i}`, 1, 0));
	}
	tui.addChild(chat);
	const spinner = new Text("⠋ Working…", 1, 0);
	tui.addChild(spinner);
	return { tui, spinner };
}

/** Average ms per frame over FRAMES spinner ticks (one bottom line changes each). */
function measure(n: number): { ms: number; cache: number } {
	const { tui, spinner } = build(n);
	doRender(tui); // warm: first full render
	let total = 0;
	for (let f = 0; f < FRAMES; f++) {
		spinner.setText(`${SPINNER_FRAMES[f % SPINNER_FRAMES.length]} Working…`);
		const t0 = performance.now();
		doRender(tui);
		total += performance.now() - t0;
	}
	return { ms: total / FRAMES, cache: tui.getResetCacheSizeForTest() };
}

function fmt(ms: number): string {
	return ms.toFixed(3).padStart(8);
}

console.log(`Render hot-path bench — ${FRAMES} spinner frames per size\n`);
console.log("    N | gated ms/f |  scan ms/f |  cache |  ~max fps (gated)");
console.log("------|------------|------------|--------|------------------");
for (const n of SIZES) {
	// #1 "after": non-Kitty caps → Kitty scan short-circuits.
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	const gated = measure(n);
	// #1 "before": Kitty caps → per-line scan runs over every line.
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	const scan = measure(n);
	resetCapabilitiesCache();
	const fps = gated.ms > 0 ? Math.round(1000 / gated.ms) : 0;
	console.log(
		`${String(n).padStart(5)} | ${fmt(gated.ms)}   | ${fmt(scan.ms)}   | ${String(gated.cache).padStart(6)} | ${String(fps).padStart(6)}`,
	);
}
console.log(
	"\ngated = #1 active (Kitty scan skipped); scan = pre-#1 cost; cache = reset entries held (#2: ≈N, never capped at 4096).",
);
