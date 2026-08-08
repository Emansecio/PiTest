import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { setKittyProtocolActive } from "./keys.ts";
import { StdinBuffer } from "./stdin-buffer.ts";

const cjsRequire = createRequire(import.meta.url);

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0;\x07";

// Debounce window for terminal resize (SIGWINCH) events, applied leading+trailing.
// During a continuous drag-resize the terminal emits many "resize" events per second;
// each one would otherwise trigger a full clear+scrollback redraw of the whole
// transcript. Coalescing the burst into a leading redraw (so the drag isn't frozen)
// plus one trailing redraw at rest keeps drags smooth without repainting mid-burst.
const TERMINAL_RESIZE_DEBOUNCE_MS = 70;

/**
 * Minimal terminal interface for TUI
 */
export interface Terminal {
	// Start the terminal with input and resize handlers
	start(onInput: (data: string) => void, onResize: () => void): void;

	// Stop the terminal and restore state
	stop(): void;

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	// Write output to terminal
	write(data: string): void;

	// Get terminal dimensions
	get columns(): number;
	get rows(): number;

	// Whether Kitty keyboard protocol is active
	get kittyProtocolActive(): boolean;

	// Cursor positioning (relative to current position)
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	// Cursor visibility
	hideCursor(): void; // Hide the cursor
	showCursor(): void; // Show the cursor

	// Clear operations
	clearLine(): void; // Clear current line
	clearFromCursor(): void; // Clear from cursor to end of screen
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	// Title operations
	setTitle(title: string): void; // Set terminal window title

	// Progress indicator (OSC 9;4)
	setProgress(active: boolean): void;

	/**
	 * Whether the underlying output stream currently has a full write buffer
	 * (the last write() call returned false). Optional so existing test mocks
	 * that never implement backpressure keep compiling — TUI treats a missing
	 * implementation as "never backpressured".
	 */
	isBackpressured?(): boolean;

	/**
	 * Register a callback invoked once the underlying stream drains (fires at
	 * most once per registration; re-register for the next backpressure
	 * episode). Optional for the same reason as isBackpressured().
	 */
	onDrain?(cb: () => void): void;

	/**
	 * Enable/disable mouse tracking (SGR button-event mode). Optional so existing
	 * Terminal implementations (VirtualTerminal, test mocks) keep compiling — the
	 * wiring treats a missing implementation as a no-op. Idempotent per contract.
	 */
	enableMouse?(): void;
	disableMouse?(): void;

	/**
	 * Set the session-level mouse tracking intent (the runtime /mouse toggle).
	 * Distinct from enableMouse/disableMouse, which flip the physical tracking
	 * state directly (used by the TUI's wheel auto-suspend): this setter records
	 * intent and, when the terminal is already started, applies it immediately.
	 * Optional for the same compile-compat reason as enableMouse/disableMouse.
	 */
	setMouseEnabled?(enabled: boolean): void;
}

/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	private wasRaw = false;
	// Session-level mouse intent, distinct from the physical tracking state below.
	// Default false in this PR — the coding-agent turns it on (PR4) via the
	// constructor arg or setMouseEnabled(). Survives stop()/start() so suspend/
	// resume (SIGTSTP → stop()/start()) re-arms tracking automatically.
	private mouseEnabled: boolean;
	// Whether the 1002/1006 tracking sequences are currently written to the
	// terminal. Guards enable/disable so they stay idempotent: disable only emits
	// when tracking was actually on (e.g. drainInput() then stop() writes once).
	private mouseTrackingOn = false;
	// Whether start() has run without a matching stop(). Gates setMouseEnabled()'s
	// immediate apply: before start() the flag alone suffices (start() emits the
	// sequence itself), and after stop() there is nothing live to write to.
	private started = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	// Listener actually attached to process.stdout "resize"; debounces bursts of
	// SIGWINCH events down to a single resizeHandler() call once the drag stops.
	private resizeListener?: () => void;
	private resizeDebounceTimer?: ReturnType<typeof setTimeout>;
	// Set when a resize event arrives while resizeDebounceTimer is already running (mid-burst),
	// so the timer's expiry knows a distinct trailing frame is owed beyond the leading one.
	private resizePendingTrailing = false;
	private kittyFallbackTimer?: ReturnType<typeof setTimeout>;
	private _kittyProtocolActive = false;
	private _modifyOtherKeysActive = false;
	// Backpressure tracking: set when process.stdout.write() reports its internal
	// buffer is full, cleared on the stream's "drain" event. TUI polls
	// isBackpressured() at the top of each render and skips producing/writing a
	// new frame while it's true, instead registering an onDrain callback — so a
	// slow consumer (SSH, a piped terminal) can't make frames queue up in process
	// RAM unbounded.
	private backpressured = false;
	private drainCallbacks = new Set<() => void>();
	private drainListener?: () => void;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;
	private progressInterval?: ReturnType<typeof setInterval>;
	private writeLogPath = (() => {
		const env = process.env.PIT_TUI_WRITE_LOG || "";
		if (!env) return "";
		try {
			if (fs.statSync(env).isDirectory()) {
				const now = new Date();
				const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
				return path.join(env, `tui-${ts}-${process.pid}.log`);
			}
		} catch {
			// Not an existing directory - use as-is (file path)
		}
		return env;
	})();

	/**
	 * @param mouseEnabled - Seed the session mouse intent. Default false in this
	 * PR; the coding-agent (PR4) constructs with true / flips it via setMouseEnabled().
	 */
	constructor(mouseEnabled = false) {
		this.mouseEnabled = mouseEnabled;
	}

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		this.started = true;

		// Save previous state and enable raw mode
		this.wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		process.stdout.write("\x1b[?2004h");

		// Enable mouse tracking right after bracketed paste when this session has it
		// turned on. Gated by the flag (default off in this PR — the on-by-default
		// wiring arrives in the coding-agent, PR4). Idempotent via mouseTrackingOn.
		if (this.mouseEnabled) {
			this.enableMouse();
		}

		// Set up resize handler with a leading+trailing debounce: the first event of a
		// burst repaints immediately (so a drag-resize isn't frozen until you let go),
		// and later events in the same burst only rearm the trailing timer so the final
		// settled size still gets one closing redraw. No repaints in between - each one
		// is a full clear+scrollback redraw and doing that per SIGWINCH would be ~60/sec.
		this.resizeListener = () => {
			if (this.resizeDebounceTimer) {
				this.resizePendingTrailing = true;
				clearTimeout(this.resizeDebounceTimer);
			} else {
				this.resizeHandler?.();
			}
			this.resizeDebounceTimer = setTimeout(() => {
				this.resizeDebounceTimer = undefined;
				if (this.resizePendingTrailing) {
					this.resizePendingTrailing = false;
					this.resizeHandler?.();
				}
			}, TERMINAL_RESIZE_DEBOUNCE_MS);
			(this.resizeDebounceTimer as { unref?: () => void }).unref?.();
		};
		process.stdout.on("resize", this.resizeListener);

		// Track stdout backpressure for the lifetime of this session; removed in
		// stop(). One listener regardless of how many onDrain() callbacks are
		// pending — each "drain" event flushes and clears all of them.
		this.drainListener = () => {
			this.backpressured = false;
			if (this.drainCallbacks.size === 0) return;
			const callbacks = Array.from(this.drainCallbacks);
			this.drainCallbacks.clear();
			for (const cb of callbacks) cb();
		};
		process.stdout.on("drain", this.drainListener);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only.
		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run AFTER setRawMode(true)
		// since that resets console mode flags.
		this.enableWindowsVTInput();

		// Query and enable Kitty keyboard protocol
		// The query handler intercepts input temporarily, then installs the user's handler
		// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.queryAndEnableKittyProtocol();
	}

	/**
	 * Set up StdinBuffer to split batched input into individual sequences.
	 * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
	 *
	 * Also watches for Kitty protocol response and enables it when detected.
	 * This is done here (after stdinBuffer parsing) rather than on raw stdin
	 * to handle the case where the response arrives split across multiple events.
	 */
	private setupStdinBuffer(): void {
		this.stdinBuffer = new StdinBuffer({ timeout: 10 });

		// Kitty protocol response pattern: \x1b[?<flags>u
		const kittyResponsePattern = /^\x1b\[\?(\d+)u$/;

		// Forward individual sequences to the input handler
		this.stdinBuffer.on("data", (sequence) => {
			// Check for Kitty protocol response (only if not already enabled)
			if (!this._kittyProtocolActive) {
				const match = sequence.match(kittyResponsePattern);
				if (match) {
					this._kittyProtocolActive = true;
					setKittyProtocolActive(true);

					// Enable Kitty keyboard protocol (push flags)
					// Flag 1 = disambiguate escape codes
					// Flag 2 = report event types (press/repeat/release)
					// Flag 4 = report alternate keys (shifted key, base layout key)
					// Base layout key enables shortcuts to work with non-Latin keyboard layouts
					process.stdout.write("\x1b[>7u");
					return; // Don't forward protocol response to TUI
				}
			}

			if (this.inputHandler) {
				this.inputHandler(sequence);
			}
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.stdinBuffer.on("paste", (content) => {
			if (this.inputHandler) {
				this.inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		this.stdinDataHandler = (data: string) => {
			this.stdinBuffer!.process(data);
		};
	}

	/**
	 * Query terminal for Kitty keyboard protocol support and enable if available.
	 *
	 * Sends CSI ? u to query current flags. If terminal responds with CSI ? <flags> u,
	 * it supports the protocol and we enable it with CSI > 1 u.
	 *
	 * If no Kitty response arrives shortly after startup, fall back to enabling
	 * xterm modifyOtherKeys mode 2. This is needed for tmux, which can forward
	 * modified enter keys as CSI-u when extended-keys is enabled, but may not
	 * answer the Kitty protocol query.
	 *
	 * The response is detected in setupStdinBuffer's data handler, which properly
	 * handles the case where the response arrives split across multiple stdin events.
	 */
	private queryAndEnableKittyProtocol(): void {
		// Even a dumb terminal still needs the input splitter/listener so normal
		// keystrokes and bracketed-paste payloads are delivered safely. It must not,
		// however, receive capability queries (nor the delayed modifyOtherKeys
		// fallback): TERM=dumb consumers commonly treat escape output as literal.
		this.setupStdinBuffer();
		process.stdin.on("data", this.stdinDataHandler!);
		if (process.env.TERM?.toLowerCase() === "dumb") return;

		process.stdout.write("\x1b[?u");
		this.kittyFallbackTimer = setTimeout(() => {
			this.kittyFallbackTimer = undefined;
			if (!this._kittyProtocolActive && !this._modifyOtherKeysActive) {
				process.stdout.write("\x1b[>4;2m");
				this._modifyOtherKeysActive = true;
			}
		}, 150);
		(this.kittyFallbackTimer as { unref?: () => void }).unref?.();
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) to the stdin
	 * console handle so the terminal sends VT sequences for modified keys
	 * (e.g. \x1b[Z for Shift+Tab). Without this, libuv's ReadConsoleInputW
	 * discards modifier state and Shift+Tab arrives as plain \t.
	 */
	private enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		try {
			// Dynamic require to avoid bundling koffi's 74MB of cross-platform
			// native binaries into every compiled binary. Koffi is only needed
			// on Windows for VT input support.
			const koffi = cjsRequire("koffi");
			const k32 = koffi.load("kernel32.dll");
			const GetStdHandle = k32.func("void* __stdcall GetStdHandle(int)");
			const GetConsoleMode = k32.func("bool __stdcall GetConsoleMode(void*, _Out_ uint32_t*)");
			const SetConsoleMode = k32.func("bool __stdcall SetConsoleMode(void*, uint32_t)");

			const STD_INPUT_HANDLE = -10;
			const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;
			const handle = GetStdHandle(STD_INPUT_HANDLE);
			const mode = new Uint32Array(1);
			GetConsoleMode(handle, mode);
			SetConsoleMode(handle, mode[0]! | ENABLE_VIRTUAL_TERMINAL_INPUT);
		} catch {
			// koffi not available — Shift+Tab won't be distinguishable from Tab
		}
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		if (this.kittyFallbackTimer) {
			clearTimeout(this.kittyFallbackTimer);
			this.kittyFallbackTimer = undefined;
		}
		if (this._kittyProtocolActive) {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences.
			process.stdout.write("\x1b[<u");
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this._modifyOtherKeysActive) {
			process.stdout.write("\x1b[>4;0m");
			this._modifyOtherKeysActive = false;
		}
		// Same rationale as the kitty/modifyOtherKeys disables above: stop generating
		// new escape sequences during the drain so late mouse events can't leak SGR
		// reports to the parent shell. Idempotent — no-op if tracking was never on.
		this.disableMouse();

		const previousHandler = this.inputHandler;
		this.inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.inputHandler = previousHandler;
		}
	}

	stop(): void {
		this.started = false;
		if (this.clearProgressInterval()) {
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}

		// Cancel the pending Kitty-fallback timer so it cannot write
		// modifyOtherKeys-enable escapes (or set _modifyOtherKeysActive) after
		// teardown when stop() runs within 150ms of start().
		if (this.kittyFallbackTimer) {
			clearTimeout(this.kittyFallbackTimer);
			this.kittyFallbackTimer = undefined;
		}

		// Disable bracketed paste mode
		process.stdout.write("\x1b[?2004l");

		// Disable mouse tracking (idempotent — no-op if drainInput() already did it,
		// or if this session never had mouse enabled). mouseEnabled is left intact so
		// a later start() (suspend/resume) re-arms tracking automatically.
		this.disableMouse();

		// Restore the cursor. The Terminal.stop() contract now guarantees the
		// cursor is shown regardless of caller, so any teardown path (including
		// the pre-interactive signal guard) leaves it visible even if TUI.stop()
		// was bypassed or threw before its own showCursor().
		process.stdout.write("\x1b[?25h");

		// Disable Kitty keyboard protocol if not already done by drainInput()
		if (this._kittyProtocolActive) {
			process.stdout.write("\x1b[<u");
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this._modifyOtherKeysActive) {
			process.stdout.write("\x1b[>4;0m");
			this._modifyOtherKeysActive = false;
		}

		// Clean up StdinBuffer
		if (this.stdinBuffer) {
			this.stdinBuffer.destroy();
			this.stdinBuffer = undefined;
		}

		// Remove event handlers
		if (this.stdinDataHandler) {
			process.stdin.removeListener("data", this.stdinDataHandler);
			this.stdinDataHandler = undefined;
		}
		this.inputHandler = undefined;
		// Cancel any pending debounced resize and detach the listener.
		if (this.resizeDebounceTimer) {
			clearTimeout(this.resizeDebounceTimer);
			this.resizeDebounceTimer = undefined;
		}
		this.resizePendingTrailing = false;
		if (this.resizeListener) {
			process.stdout.removeListener("resize", this.resizeListener);
			this.resizeListener = undefined;
		}
		this.resizeHandler = undefined;
		if (this.drainListener) {
			process.stdout.removeListener("drain", this.drainListener);
			this.drainListener = undefined;
		}
		this.backpressured = false;
		this.drainCallbacks.clear();

		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		process.stdin.pause();

		// Restore raw mode state
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
	}

	write(data: string): void {
		const ok = process.stdout.write(data);
		// A false return means the stream's highWaterMark was crossed. On a
		// SYNCHRONOUS stream — a Windows console, or any regular file — the bytes are
		// already flushed by the time write() returns: writableLength is 0 and no
		// 'drain' event will ever fire. Honoring backpressure there would wedge the
		// flag at true forever (nothing clears it but 'drain'), so _doRenderCore would
		// skip every non-forced frame and the UI would freeze while state kept
		// updating. Only treat it as real backpressure when bytes are still buffered
		// (an async pipe/socket — SSH), where 'drain' is guaranteed to come.
		if (!ok && process.stdout.writableLength > 0) this.backpressured = true;
		if (this.writeLogPath) {
			try {
				fs.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
			} catch {
				// Ignore logging errors
			}
		}
	}

	isBackpressured(): boolean {
		return this.backpressured;
	}

	onDrain(cb: () => void): void {
		this.drainCallbacks.add(cb);
	}

	enableMouse(): void {
		// 1002 = button-event tracking (press/release/drag) — never 1003 (any-motion),
		// which floods on every pixel of movement. 1006 = SGR extended coordinates,
		// which avoids the legacy 223-column limit of the old byte-encoded scheme.
		if (this.mouseTrackingOn) return;
		process.stdout.write("\x1b[?1002h\x1b[?1006h");
		this.mouseTrackingOn = true;
	}

	disableMouse(): void {
		// Idempotent: only emit the disable pair when tracking is actually on, so a
		// double disable (e.g. drainInput() then stop()) writes the sequence once.
		if (!this.mouseTrackingOn) return;
		process.stdout.write("\x1b[?1002l\x1b[?1006l");
		this.mouseTrackingOn = false;
	}

	/**
	 * Turn mouse tracking on/off for this session (used by the runtime /mouse toggle,
	 * PR4). The intent survives stop()/start(), so suspend/resume re-arms tracking on
	 * its own. When the terminal is already started the change takes effect immediately;
	 * before start() the flag alone is enough (start() emits the enable sequence), and
	 * after stop() there is nothing live to write to.
	 */
	setMouseEnabled(enabled: boolean): void {
		this.mouseEnabled = enabled;
		if (!this.started) return;
		if (enabled) {
			this.enableMouse();
		} else {
			this.disableMouse();
		}
	}

	get columns(): number {
		return process.stdout.columns || Number(process.env.COLUMNS) || 80;
	}

	get rows(): number {
		return process.stdout.rows || Number(process.env.LINES) || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			process.stdout.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			process.stdout.write(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		process.stdout.write("\x1b[?25l");
	}

	showCursor(): void {
		process.stdout.write("\x1b[?25h");
	}

	clearLine(): void {
		process.stdout.write("\x1b[K");
	}

	clearFromCursor(): void {
		process.stdout.write("\x1b[J");
	}

	clearScreen(): void {
		process.stdout.write("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		process.stdout.write(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		if (active) {
			// OSC 9;4;3 - indeterminate progress
			process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.progressInterval) {
				this.progressInterval = setInterval(() => {
					process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
				// Don't keep the event loop alive just for the progress keepalive.
				(this.progressInterval as { unref?: () => void }).unref?.();
			}
		} else {
			this.clearProgressInterval();
			// OSC 9;4;0 - clear progress
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	private clearProgressInterval(): boolean {
		if (!this.progressInterval) return false;
		clearInterval(this.progressInterval);
		this.progressInterval = undefined;
		return true;
	}
}
