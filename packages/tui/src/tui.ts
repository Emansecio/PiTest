/**
 * Minimal TUI implementation with differential rendering
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { isKeyRelease, matchesKey } from "./keys.ts";
import type { Terminal } from "./terminal.ts";
import {
	deleteKittyImage,
	getCapabilities,
	isImageLine,
	isSixelForcedOff,
	parseSixelDeviceAttributes,
	setCellDimensions,
	setSixelSupport,
} from "./terminal-image.ts";
import {
	extractSegments,
	normalizeTerminalOutput,
	sliceByColumn,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
} from "./utils.ts";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";
// Shared, never-mutated empty id set returned by collectKittyImageIds on every
// non-Kitty terminal (the overwhelming common case). Callers only ever read it
// (iterate it in deleteKittyImages, or replace `previousKittyImageIds` wholesale
// with a fresh return value) — nothing indexes into it and mutates in place, so
// one shared instance is safe and skips a per-frame `new Set()` allocation plus
// the O(total lines) scan that would otherwise fill it with nothing.
const EMPTY_KITTY_IDS: Set<number> = new Set();
const RENDER_FAULT_VISIBLE_MS = 5000;
const RENDER_FAULT_MAX_MESSAGE_WIDTH = 240;
const ANSI_ESCAPE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?|_[^\x07]*(?:\x07|\x1b\\)?|.)/g;
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/g;
const SPACES_PATTERN = /\s+/g;
const UNKNOWN_RENDER_FAULT = "unknown error";

// Dev-only render guard. When enabled, each component's rendered lines are
// checked against `width` *at the component boundary*, throwing an error that
// names the culprit. Without it, an overflow only surfaces later in
// TUI.doRender as a generic "Rendered line N exceeds terminal width" against
// the merged line buffer — by then the offending component is anonymous.
// Opt-in (PIT_RENDER_ASSERT=1) so production renders pay no extra cost; the
// flag is mutable so tests can toggle it without import-time env ordering.
let renderAssertEnabled = process.env.PIT_RENDER_ASSERT === "1";

/** Enable/disable the per-component render width guard (see {@link assertComponentWidth}). */
export function setRenderAssertEnabled(enabled: boolean): void {
	renderAssertEnabled = enabled;
}

/** Current state of the per-component render width guard. Lets tests capture and restore it. */
export function isRenderAssertEnabled(): boolean {
	return renderAssertEnabled;
}

/**
 * Throw if any line a component produced is wider than `width`, naming the
 * component and quoting the offending line. Pure and side-effect free except
 * the throw — safe to unit test directly.
 */
export function assertComponentWidth(component: Component, lines: string[], width: number): void {
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (isImageLine(line)) continue;
		const w = visibleWidth(line);
		if (w > width) {
			const name = component?.constructor?.name ?? "Component";
			const preview = JSON.stringify(line.slice(0, 160));
			throw new Error(
				`TUI render assert: ${name}.render(${width}) emitted line ${i} with visible width ${w} (> ${width}). ` +
					`A custom component must truncate its own output with truncateToWidth(). ` +
					`Offending line (first 160 chars, escaped): ${preview}`,
			);
		}
	}
}

type RenderFaultKind = "render" | "animation";

interface RenderFault {
	kind: RenderFaultKind;
	count: number;
	message: string;
	expiresAt: number;
}

function sanitizeRenderFaultMessage(message: string): string {
	const sanitized = message
		.replace(ANSI_ESCAPE_PATTERN, "")
		.replace(CONTROL_PATTERN, " ")
		.replace(SPACES_PATTERN, " ")
		.trim();
	if (sanitized.length === 0) return UNKNOWN_RENDER_FAULT;
	return truncateToWidth(sanitized, RENDER_FAULT_MAX_MESSAGE_WIDTH, "…");
}

function errorToMessage(error: unknown): string {
	try {
		if (error instanceof Error) return sanitizeRenderFaultMessage(error.message);
		if (typeof error === "string") return sanitizeRenderFaultMessage(error);
		return sanitizeRenderFaultMessage(String(error));
	} catch {
		return UNKNOWN_RENDER_FAULT;
	}
}

function componentName(component: Component): string {
	return component?.constructor?.name ?? "Component";
}

function formatComponentRenderError(component: Component, error: unknown, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(`! render error in ${componentName(component)}: ${errorToMessage(error)}`, width, "…");
}

function extractKittyImageIds(line: string): number[] {
	// Kitty placeholder sequences only exist under the Kitty image protocol. On
	// every other terminal (Windows Terminal, VSCode, iTerm2, tmux, unknown) no
	// rendered line can contain them, so skip the full-line scan entirely. This
	// runs once per line on every render path (collect/expand/delete), so the
	// guard removes an O(total chars) pass per frame on non-Kitty terminals.
	// getCapabilities() is cached → O(1).
	if (getCapabilities().images !== "kitty") return [];
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return [];

	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return [];

	const params = line.slice(paramsStart, paramsEnd);
	for (const param of params.split(",")) {
		const [key, value] = param.split("=", 2);
		if (key !== "i" || value === undefined) continue;
		const id = Number(value);
		if (Number.isInteger(id) && id > 0 && id <= 0xffffffff) {
			return [id];
		}
	}
	return [];
}

/**
 * Component interface - all components must implement this
 */
export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 *
	 * Memoization contract (relied on by Container.render and Box.render):
	 * when the output changes, return a *new* array; when it is unchanged you may
	 * return the same array instance, but you must NOT mutate an
	 * already-returned array in place. Parents detect "this child changed" by the
	 * returned array's reference identity, so an in-place mutation that keeps the
	 * same reference would be missed and show stale content. The built-in
	 * components honor this by reallocating their cached lines on
	 * setText()/invalidate().
	 */
	render(width: number): string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;
}

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;

/**
 * Animation tick callback. Invoked once per animation frame with a shared
 * monotonic clock (ms, from performance.now()). Derive any spinner/pulse frame
 * from `now` so every animated component stays phase-locked, and return `true`
 * only when the visible output changed this frame — the ticker coalesces a
 * single render for all animations and skips frames that change nothing.
 */
export type AnimationFrameCallback = (now: number) => boolean;

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
	/** If true, don't capture keyboard focus when shown */
	nonCapturing?: boolean;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
	/** Focus this overlay and bring it to the visual front */
	focus(): void;
	/** Release focus to the previous target */
	unfocus(): void;
	/** Check if this overlay currently has focus */
	isFocused(): boolean;
}

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];

	// Memoized flatten of the children's rendered lines. Rebuilding the merged
	// array every frame is O(total lines); on the steady-state hot path (long
	// transcript, one bottom line changing per spinner tick) that dominates.
	// We re-call each child's render() every frame anyway — built-in components
	// memoize internally and hand back the *same* array object when nothing
	// changed — so a child signals "I changed" by returning a different array
	// reference (setText/invalidate always reallocate; they never mutate the
	// cached array in place). When width, the child list, and every child's
	// returned array reference all match last frame, the previously flattened
	// output is byte-identical and is reused without re-pushing. assertComponentWidth
	// still runs per child every frame (it is gated by PIT_RENDER_ASSERT). When only
	// a suffix of children changed (same width/child-count), render() reuses the
	// unchanged prefix via slice() instead of rebuilding the whole array — see
	// flattenCacheChildOffsets below.
	private flattenCacheWidth = -1;
	private flattenCacheChildOutputs: string[][] = [];
	private flattenCacheLines: string[] = [];
	// Per-child starting offset into flattenCacheLines from the last flatten
	// (full rebuild or prefix-reused — see render()). Always resized/recomputed
	// in lockstep with flattenCacheChildOutputs, so it is safe to index once
	// `flattenCacheChildOutputs.length === children.length` holds.
	private flattenCacheChildOffsets: number[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		const children = this.children;
		const childOutputs = new Array<string[]>(children.length);
		// sameShape: width and child count match last frame, so flattenCacheChildOffsets
		// (computed against that same shape) is valid for prefix reuse below.
		const sameShape = this.flattenCacheWidth === width && this.flattenCacheChildOutputs.length === children.length;
		let reusable = sameShape;
		// First index (in left-to-right scan order) whose child output array reference
		// changed. Only meaningful when sameShape held for the whole scan, since the
		// `reusable &&` guard below stops updating it the moment shape mismatches.
		let minChangedIndex = -1;
		for (let i = 0; i < children.length; i++) {
			let childLines: string[];
			try {
				childLines = children[i].render(width);
			} catch (error) {
				childLines = [formatComponentRenderError(children[i], error, width)];
			}
			if (renderAssertEnabled) assertComponentWidth(children[i], childLines, width);
			childOutputs[i] = childLines;
			if (reusable && childLines !== this.flattenCacheChildOutputs[i]) {
				reusable = false;
				minChangedIndex = i;
			}
		}
		if (reusable) return this.flattenCacheLines;

		// Prefix reuse: every child before minChangedIndex produced byte-identical
		// output to last frame (same width/child-count, and the scan above never
		// flagged them), so splice the new tail onto a slice() of the unchanged
		// prefix instead of re-pushing every child's lines. This is the dominant
		// win during streaming, where typically only the last child (or line)
		// changes per frame. Still returns a brand-new array (slice() + push),
		// preserving the render() contract.
		if (sameShape && minChangedIndex !== -1) {
			const offset = this.flattenCacheChildOffsets[minChangedIndex] ?? 0;
			const lines = this.flattenCacheLines.slice(0, offset);
			const offsets = this.flattenCacheChildOffsets;
			let cursor = offset;
			for (let i = minChangedIndex; i < childOutputs.length; i++) {
				offsets[i] = cursor;
				const childLines = childOutputs[i];
				for (let j = 0; j < childLines.length; j++) {
					lines.push(childLines[j]);
				}
				cursor += childLines.length;
			}
			this.flattenCacheWidth = width;
			this.flattenCacheChildOutputs = childOutputs;
			this.flattenCacheLines = lines;
			this.flattenCacheChildOffsets = offsets;
			return lines;
		}

		const lines: string[] = [];
		const offsets = new Array<number>(childOutputs.length);
		for (let i = 0; i < childOutputs.length; i++) {
			offsets[i] = lines.length;
			const childLines = childOutputs[i];
			for (let j = 0; j < childLines.length; j++) {
				lines.push(childLines[j]);
			}
		}
		this.flattenCacheWidth = width;
		this.flattenCacheChildOutputs = childOutputs;
		this.flattenCacheLines = lines;
		this.flattenCacheChildOffsets = offsets;
		return lines;
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	public terminal: Terminal;
	private previousLines: string[] = [];
	/** Alternating scratch buffers for CURSOR_MARKER stripping (avoids O(N) alloc + keeps previousLines intact). */
	private cursorStripScratchA: string[] = [];
	private cursorStripScratchB: string[] = [];
	private cursorStripUseA = true;
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	private focusedComponent: Component | null = null;
	private inputListeners = new Set<InputListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	public onDebug?: () => void;
	private renderRequested = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private inputRenderQueued = false;
	private lastRenderAt = 0;
	// Guards against registering more than one onDrain() callback per
	// backpressure episode (see _doRenderCore); cleared when that callback fires.
	private drainCallbackRegistered = false;
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	// Shared animation ticker: a single timer drives every animated component
	// (spinners, pulses) off one monotonic clock so their phases stay locked and a
	// frame that changes nothing never schedules a render. See addAnimationCallback().
	private animationCallbacks = new Set<AnimationFrameCallback>();
	// Reused each tick to snapshot callbacks without allocating an array per
	// frame; preserves the snapshot semantics (mutation mid-tick is deferred).
	private animationTickBuffer: AnimationFrameCallback[] = [];
	private animationTimer: NodeJS.Timeout | undefined;
	private static readonly ANIMATION_FRAME_MS = 16;
	// Tracks CONSECUTIVE failures per callback so a persistently-throwing
	// animation (e.g. a spinner tick with a bug) can be evicted instead of
	// spinning the renderer at 60fps forever. Reset to zero on any successful
	// tick; a callback is only ever present here while it has an active streak.
	private animationFaultCounts = new Map<AnimationFrameCallback, number>();
	private static readonly ANIMATION_FAULT_EVICT_AFTER = 5;
	// Consecutive doRender() failures that re-request a frame. Without a cap,
	// a persistent render throw (diff/compositing) reschedules at ~60Hz forever
	// and never commits a good frame (CPU pegged, UI looks frozen).
	private consecutiveRenderFaults = 0;
	private static readonly RENDER_FAULT_EVICT_AFTER = 5;
	private renderFaultSuppressed = false;
	private cursorRow = 0; // Logical cursor row (end of rendered content)
	private hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	// Last DECTCEM visibility (show/hide) actually written, so positionHardwareCursor
	// only emits \x1b[?25h/l on a change instead of every frame. undefined = unknown
	// (forces the next frame to emit unconditionally).
	private hardwareCursorVisible: boolean | undefined;
	private showHardwareCursor = process.env.PIT_HARDWARE_CURSOR === "1";
	private clearOnShrink = process.env.PIT_CLEAR_ON_SHRINK === "1"; // Clear empty rows when content shrinks (default: off)
	private maxLinesRendered = 0; // Track terminal's working area (max lines ever rendered)
	private previousViewportTop = 0; // Track previous viewport top for resize-aware cursor moves
	private fullRedrawCount = 0;
	private stopped = false;
	private renderFault: RenderFault | null = null;
	private renderFaultClearTimer: NodeJS.Timeout | undefined;
	// Per-line memoization of normalizeTerminalOutput(line) + SEGMENT_RESET. Markdown
	// caches its rendered lines, so unchanged content keeps stable string identity
	// across renders; this cache turns the per-frame O(N) reset concatenation into
	// O(1) hits on those lines. FIFO-evicted once cache exceeds RESET_CACHE_MAX.
	private readonly resetCache = new Map<string, string>();
	// Reference-identity fast path for applyLineResets. Components memoize their
	// rendered lines (see Text/Markdown), so unchanged lines arrive as the *same*
	// string object every frame. Holding last frame's input array and its reset
	// output lets the steady-state loop reuse a line's reset value with a pointer
	// compare + index lookup instead of hashing the full string for the Map. The
	// produced output bytes are identical to recomputing via the Map; only the
	// per-line cost of the O(N) walk drops. Both arrays are replaced wholesale
	// each call so they can never drift from the array we return.
	private resetInputCache: string[] = [];
	private resetOutputCache: string[] = [];
	// Double-buffer pool backing resetInputCache/resetOutputCache. Rebuilding
	// nextInput/nextOutput used to allocate two N-length arrays on every frame
	// where at least one line changed; instead we keep two (input, output) pairs
	// and alternate between them, resizing (`.length =`) rather than allocating.
	// nextInput never escapes this class, so its slot is always safe to reuse.
	// nextOutput *is* returned and becomes `this.previousLines` — see the guard
	// in applyLineResets before either slot is reused.
	private resetBufferInputA: string[] = [];
	private resetBufferOutputA: string[] = [];
	private resetBufferInputB: string[] = [];
	private resetBufferOutputB: string[] = [];
	private resetBufferUseA = true;
	private diffScanCountForTest = 0;
	// Pointer-identity memo for collectKittyImageIds (Kitty terminals only; see
	// that method). kittyIdsPrevLines is the last committed frame's lines array;
	// kittyIdsPrevPerLine holds each line's extracted ids at the same index. The
	// next/prev per-line arrays swap roles each commit to avoid per-frame
	// allocation. Never read unless a line's string identity matches, so stale
	// entries (e.g. after a capability flip) can never produce wrong ids.
	private kittyIdsPrevLines: string[] = [];
	private kittyIdsPrevPerLine: number[][] = [];
	private kittyIdsNextPerLine: number[][] = [];
	/** First index whose pre-reset line changed this frame (from applyLineResets). */
	private resetFirstDirty = 0;
	private static readonly FULL_RENDER_CHUNK_LINES = 2000;
	// Per-line memoization of visibleWidth(line), consumed by clampLineToWidth on
	// both the full-redraw and differential paths. fullRender (triggered by a
	// terminal resize) walks *every* rendered line through clampLineToWidth even
	// though a resize never changes a line's content — without this memo that
	// re-segments the whole transcript on every resize. FIFO-evicted with the
	// same cap-scales-with-the-frame pattern as resetCache (see WIDTH_CACHE_MIN/
	// WIDTH_CACHE_HARD_MAX below); keyed by line content (Map value equality), so
	// a hit doesn't require object identity.
	private readonly widthCache = new Map<string, number>();

	// Overlay stack for modal components rendered on top of base content
	private focusOrderCounter = 0;
	private overlayStack: {
		component: Component;
		options?: OverlayOptions;
		preFocus: Component | null;
		hidden: boolean;
		focusOrder: number;
	}[] = [];
	/** Cached overlay entry whose component === focusedComponent. Kept in sync by setFocus(). */
	private focusedOverlay: (typeof this.overlayStack)[number] | null = null;

	constructor(terminal: Terminal, showHardwareCursor?: boolean) {
		super();
		this.terminal = terminal;
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true (default), empty rows are cleared when content shrinks.
	 * When false, empty rows remain (reduces redraws on slower terminals).
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	setFocus(component: Component | null): void {
		// Clear focused flag on old component
		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
		}

		this.focusedComponent = component;
		this.focusedOverlay =
			component === null ? null : (this.overlayStack.find((o) => o.component === component) ?? null);

		// Set focused flag on new component
		if (isFocusable(component)) {
			component.focused = true;
		}
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry = {
			component,
			options,
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
		};
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay had focus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						entry.focusOrder = ++this.focusOrderCounter;
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				if (this.focusedComponent !== component) {
					this.setFocus(component);
				}
				entry.focusOrder = ++this.focusOrderCounter;
				this.requestRender();
			},
			unfocus: () => {
				if (this.focusedComponent !== component) return;
				const topVisible = this.getTopmostVisibleOverlay();
				this.setFocus(topVisible && topVisible !== entry ? topVisible.component : entry.preFocus);
				this.requestRender();
			},
			isFocused: () => this.focusedComponent === component,
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack.pop();
		if (!overlay) return;
		if (this.focusedComponent === overlay.component) {
			// Find topmost visible overlay, or fall back to preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** Check if an overlay entry is currently visible */
	private isOverlayVisible(entry: (typeof this.overlayStack)[number]): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the topmost visible capturing overlay, if any */
	private getTopmostVisibleOverlay(): (typeof this.overlayStack)[number] | undefined {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			if (this.overlayStack[i].options?.nonCapturing) continue;
			if (this.isOverlayVisible(this.overlayStack[i])) {
				return this.overlayStack[i];
			}
		}
		return undefined;
	}

	override invalidate(): void {
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	start(): void {
		this.stopped = false;
		this.terminal.start(
			(data) => this.handleInput(data),
			() => {
				// On terminal resize, force the next render onto the clean full-redraw path.
				// After the emulator reflows the buffer, differential rendering relies on
				// cursor/viewport tracking that is now stale and progressively duplicates the
				// frame — most visibly while the working spinner is driving renders mid-turn
				// (idle resizes already hit fullRender via widthChanged and stay clean).
				// Resetting previousWidth guarantees the widthChanged → fullRender("all") branch.
				// Termux toggles height for the soft keyboard and is handled differentially
				// below, so leave its path untouched.
				if (!isTermuxSession()) this.previousWidth = -1;
				this.requestRender();
			},
		);
		this.terminal.hideCursor();
		this.queryCellSize();
		this.querySixelSupport();
		// Resume the ticker for any animation registered before start().
		this.startAnimationLoop();
		this.requestRender();
	}

	addInputListener(listener: InputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	private queryCellSize(): void {
		// Cell size is used for both image rendering AND mapping the pet sixel to a
		// cell footprint, so query it whenever images OR sixel are (possibly) live.
		if (!getCapabilities().images && isSixelForcedOff()) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	/**
	 * Probe sixel support with a Primary Device Attributes query (CSI c). The
	 * reply (`ESC [ ? … ; 4 ; … c`) is parsed in the input handler. Skipped when
	 * `PIT_NO_SIXEL` already forced the cell fallback — nothing to learn. The
	 * query is a single non-blocking write; if the terminal never answers we
	 * simply keep the conservative default (cells).
	 */
	private querySixelSupport(): void {
		if (isSixelForcedOff()) return;
		this.terminal.write("\x1b[c");
	}

	/**
	 * Stops rendering and input handling. Registered animation callbacks are
	 * discarded here (not just the underlying timer): if start() is called
	 * again on this instance (embed/restart), stale closures from components
	 * that were torn down alongside this stop() must not resume ticking.
	 * Callers that intend to keep animating across a restart need to
	 * re-subscribe via addAnimationCallback() after the next start().
	 */
	stop(): void {
		this.stopped = true;
		this.stopAnimationLoop();
		this.animationCallbacks.clear();
		this.animationFaultCounts.clear();
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		if (this.renderFaultClearTimer) {
			clearTimeout(this.renderFaultClearTimer);
			this.renderFaultClearTimer = undefined;
		}
		// Move cursor to the end of the content to prevent overwriting/artifacts on exit.
		// Guard the reposition writes: a synchronous EPIPE on a half-dead pipe here must
		// not skip the cursor/raw-mode restoration below.
		try {
			if (this.previousLines.length > 0) {
				const targetRow = this.previousLines.length; // Line after the last content
				const lineDiff = targetRow - this.hardwareCursorRow;
				if (lineDiff > 0) {
					this.terminal.write(`\x1b[${lineDiff}B`);
				} else if (lineDiff < 0) {
					this.terminal.write(`\x1b[${-lineDiff}A`);
				}
				this.terminal.write("\r\n");
			}
		} catch {
			// half-dead pipe — fall through to restore anyway
		}

		this.terminal.showCursor();
		this.hardwareCursorVisible = true;
		this.terminal.stop();
	}

	requestRender(force = false): void {
		if (force) {
			this.previousLines = [];
			this.previousWidth = -1; // -1 triggers widthChanged, forcing a full clear
			this.previousHeight = -1; // -1 triggers heightChanged, forcing a full clear
			this.cursorRow = 0;
			this.hardwareCursorRow = 0;
			this.hardwareCursorVisible = undefined; // re-sync visibility after a full reset instead of trusting the dedupe
			this.maxLinesRendered = 0;
			this.previousViewportTop = 0;
			if (this.renderTimer) {
				clearTimeout(this.renderTimer);
				this.renderTimer = undefined;
			}
			this.renderRequested = true;
			process.nextTick(() => {
				if (this.stopped || !this.renderRequested) {
					return;
				}
				this.renderRequested = false;
				this.lastRenderAt = performance.now();
				// force=true: a resize or an explicit hard-reset must always paint, even
				// if stdout is currently backpressured (see _doRenderCore).
				this.doRender(true);
			});
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	private scheduleRender(): void {
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		if (elapsed >= TUI.MIN_RENDER_INTERVAL_MS) {
			// Idle (last paint was long enough ago): paint now instead of paying a
			// full setTimeout(0) hop just to throttle a render that isn't throttled.
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
			if (this.renderRequested) {
				this.scheduleRender();
			}
			return;
		}
		const delay = TUI.MIN_RENDER_INTERVAL_MS - elapsed;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
			if (this.renderRequested) {
				this.scheduleRender();
			}
		}, delay);
	}

	/**
	 * Paint editor input on the next tick instead of making keystrokes wait for
	 * the 60 Hz animation throttle. Multiple input chunks delivered in the same
	 * turn still collapse into one differential render.
	 */
	private requestInputRender(): void {
		if (this.stopped) return;
		this.renderRequested = true;
		if (this.inputRenderQueued) return;
		this.inputRenderQueued = true;
		process.nextTick(() => {
			this.inputRenderQueued = false;
			if (this.stopped || !this.renderRequested) return;
			if (this.renderTimer) {
				clearTimeout(this.renderTimer);
				this.renderTimer = undefined;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			// Keystroke after a render-fault storm: clear suppress so we retry once.
			this.renderFaultSuppressed = false;
			this.doRender();
			if (this.renderRequested) this.scheduleRender();
		});
	}

	/**
	 * Subscribe to the shared animation ticker. Every animated component derives
	 * its frame from the single monotonic clock passed to the callback, so
	 * spinners and pulses stay phase-locked instead of drifting against one
	 * another's independent timers. The ticker requests at most one render per
	 * frame, and only when some callback reports a visible change. Returns an
	 * unsubscribe function; the underlying timer stops once the last callback is
	 * removed. Safe to call before start() — the loop resumes there.
	 */
	addAnimationCallback(callback: AnimationFrameCallback): () => void {
		this.animationCallbacks.add(callback);
		this.startAnimationLoop();
		return () => {
			this.animationCallbacks.delete(callback);
			this.animationFaultCounts.delete(callback);
			if (this.animationCallbacks.size === 0) this.stopAnimationLoop();
		};
	}

	private startAnimationLoop(): void {
		if (this.animationTimer || this.stopped || this.animationCallbacks.size === 0) return;
		this.animationTimer = setInterval(() => this.tickAnimations(), TUI.ANIMATION_FRAME_MS);
		// Don't keep the event loop alive just for animations.
		(this.animationTimer as { unref?: () => void }).unref?.();
	}

	private stopAnimationLoop(): void {
		if (this.animationTimer) {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
	}

	private tickAnimations(): void {
		if (this.stopped || this.animationCallbacks.size === 0) {
			this.stopAnimationLoop();
			return;
		}
		const now = performance.now();
		let dirty = false;
		// Snapshot into a reused buffer so a callback that unsubscribes (or
		// subscribes) mid-tick can't disturb this frame's iteration, without
		// allocating a new array every frame.
		const buf = this.animationTickBuffer;
		buf.length = 0;
		for (const callback of this.animationCallbacks) buf.push(callback);
		for (let i = 0; i < buf.length; i++) {
			const callback = buf[i]!;
			// Isolate each callback: a throwing animation tick (spinner/pulse) must not
			// escape the setInterval and crash the process, nor stop the other callbacks.
			try {
				if (callback(now)) dirty = true;
				// Fast path: avoid a Map lookup/delete per callback per frame unless
				// some callback is currently mid-failure-streak.
				if (this.animationFaultCounts.size > 0 && this.animationFaultCounts.has(callback)) {
					this.animationFaultCounts.delete(callback);
				}
			} catch (error) {
				this.recordRenderFault("animation", error);
				// Keep the feedback inside the normal renderer so a faulty animation
				// can't corrupt the terminal with an out-of-band write.
				dirty = true;
				const failures = (this.animationFaultCounts.get(callback) ?? 0) + 1;
				if (failures >= TUI.ANIMATION_FAULT_EVICT_AFTER) {
					// A persistently-throwing callback would otherwise re-throw every
					// 16ms forever, pinning the render loop at 60fps. Evict it instead.
					this.animationCallbacks.delete(callback);
					this.animationFaultCounts.delete(callback);
				} else {
					this.animationFaultCounts.set(callback, failures);
				}
			}
		}
		buf.length = 0;
		if (dirty) this.requestRender();
	}

	private handleInput(data: string): void {
		try {
			this._handleInputCore(data);
		} catch {
			// A throw from an input listener, an overlay visibility predicate, or the
			// focused component's handleInput must NOT become an uncaughtException
			// (process death) on a keystroke. Drop the offending event and keep the
			// session alive; the next render reflects current state.
			this.requestInputRender();
		}
	}

	private _handleInputCore(data: string): void {
		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// Consume terminal cell size responses without blocking unrelated input.
		if (this.consumeCellSizeResponse(data)) {
			return;
		}

		// Consume the DA1 (device attributes) sixel probe response.
		if (this.consumeDeviceAttributesResponse(data)) {
			return;
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.focusedOverlay;
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				// No visible overlays, restore to preFocus
				this.setFocus(focusedOverlay.preFocus);
			}
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			this.requestInputRender();
		}
	}

	private consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * Parse a DA1 reply and record sixel support. Returns `true` only when `data`
	 * actually was a DA1 response, so genuine keystrokes fall through untouched.
	 * On a positive/negative answer the tree is invalidated so a pet that guessed
	 * "cells" can upgrade to sixel (or vice versa) on the next frame.
	 */
	private consumeDeviceAttributesResponse(data: string): boolean {
		const sixel = parseSixelDeviceAttributes(data);
		if (sixel === undefined) {
			return false;
		}
		setSixelSupport(sixel);
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === Resolve position ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
	private compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) return lines;
		// Copy before compositing: `lines` may be a Container's memoized flatten array
		// (see Container.render) and is mutated below. The spread is at the O(N) floor
		// any full-length return requires and is engine-optimized; profiling showed the
		// overlay frame cost is dominated by per-line compositing + diff, not this copy.
		const result = [...lines];

		// Pre-render all visible overlays and calculate positions
		const rendered: { overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		for (const entry of visibleEntries) {
			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayLines: string[];
			try {
				overlayLines = component.render(width);
			} catch (error) {
				overlayLines = [formatComponentRenderError(component, error, width)];
			}
			if (renderAssertEnabled) assertComponentWidth(component, overlayLines, width);

			// Apply maxHeight if specified
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// Get final row/col with actual overlay height
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

			rendered.push({ overlayLines, row, col, w: width });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}

		// Pad to at least terminal height so overlays have screen-relative positions.
		// Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
		// inflation that pushed content into scrollback on terminal widen.
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Composite each overlay
		for (const { overlayLines, row, col, w } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
				}
			}
		}

		return result;
	}

	private static readonly SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";
	// Floor for the per-line reset cache; the live cap scales with the frame (see
	// applyLineResets) so a transcript longer than this floor still gets ~100%
	// hits instead of evicting its own head every frame.
	private static readonly RESET_CACHE_MIN = 4096;
	// Hard ceiling so the cache can't grow without bound on an enormous transcript.
	private static readonly RESET_CACHE_HARD_MAX = 1 << 16; // 65536 lines
	// Same floor/ceiling pattern as RESET_CACHE_MIN/RESET_CACHE_HARD_MAX, but for
	// widthCache (see field comment above) — a separate Map with its own eviction
	// bookkeeping so the two caches' hit-rates can't starve each other.
	private static readonly WIDTH_CACHE_MIN = 4096;
	private static readonly WIDTH_CACHE_HARD_MAX = 1 << 16;

	private applyLineResets(lines: string[]): string[] {
		const reset = TUI.SEGMENT_RESET;
		const cache = this.resetCache;
		// Scale the cap with the current frame. In-order re-insertion each frame
		// means a fixed cap smaller than the transcript would evict exactly the
		// head lines we re-read first next frame → 0% hit-rate and a full
		// per-frame string recompute. 2× headroom absorbs the few lines that
		// actually change per frame; the hard max bounds memory.
		const cap = Math.min(TUI.RESET_CACHE_HARD_MAX, Math.max(TUI.RESET_CACHE_MIN, lines.length * 2));
		const prevInput = this.resetInputCache;
		const prevOutput = this.resetOutputCache;
		let firstDirty = 0;
		if (prevInput.length === lines.length && prevOutput.length === lines.length) {
			while (firstDirty < lines.length && lines[firstDirty] === prevInput[firstDirty]) {
				firstDirty++;
			}
			if (firstDirty === lines.length) {
				this.resetFirstDirty = firstDirty;
				return prevOutput;
			}
		}
		// Rebuilt this frame so it can't drift from the array returned. Holds the
		// pre-reset input (key for the pointer compare) and its post-reset output
		// at each index, for next frame's reference fast path.
		//
		// Double-buffer pool: alternate between two (input, output) pairs across
		// frames instead of allocating two fresh N-length arrays every time a line
		// changed. nextInput never leaves this method, so its slot is always safe
		// to reuse. nextOutput *is* returned and gets committed as `this.previousLines`
		// at the end of a successful frame (see doRender) — but if a *later* step in
		// this same frame throws, doRender's outer try/catch means previousLines is
		// never committed even though resetOutputCache (and this pool) already moved
		// on. A subsequent frame could then be offered the very buffer that is still
		// aliased by the stale `this.previousLines`; mutating it in place here would
		// corrupt the last committed screen state the next frame's diff depends on.
		// Guard by falling back to a fresh allocation whenever the candidate output
		// buffer is currently aliased (by previousLines, or by this frame's own
		// prevOutput, which the loop below is still reading via prevOutput[i]) — the
		// pool self-heals next frame once the stale alias is gone.
		const useBufferA = this.resetBufferUseA;
		this.resetBufferUseA = !useBufferA;
		let nextInput = useBufferA ? this.resetBufferInputA : this.resetBufferInputB;
		let nextOutput = useBufferA ? this.resetBufferOutputA : this.resetBufferOutputB;
		if (nextOutput === this.previousLines || nextOutput === prevOutput) {
			nextInput = new Array<string>(lines.length);
			nextOutput = new Array<string>(lines.length);
		} else {
			nextInput.length = lines.length;
			nextOutput.length = lines.length;
		}
		// Stable prefix: copy reset outputs from last frame (pointer-identical lines).
		for (let i = 0; i < firstDirty; i++) {
			nextInput[i] = lines[i]!;
			nextOutput[i] = prevOutput[i]!;
		}
		// Read-only over `lines`, write into `nextOutput` (which is returned). Not
		// mutating the input matters: the input may be a Container's memoized
		// flatten array (see Container.render) — mutating it in place would corrupt
		// that cache (double-applied resets, broken reference fast-path) on the
		// next frame.
		for (let i = firstDirty; i < lines.length; i++) {
			const line = lines[i]!;
			// Same string object as this index last frame → reuse its reset output
			// verbatim (pointer compare, no full-string hash). Byte-identical to the
			// Map path, including the isImageLine "leave untouched" case where the
			// stored output equals the input.
			if (line === prevInput[i] && i < prevOutput.length) {
				const out = prevOutput[i]!;
				nextInput[i] = line;
				nextOutput[i] = out;
				continue;
			}
			if (isImageLine(line)) {
				nextInput[i] = line;
				nextOutput[i] = line;
				continue;
			}
			const cached = cache.get(line);
			if (cached !== undefined) {
				nextInput[i] = line;
				nextOutput[i] = cached;
				continue;
			}
			const normalized = normalizeTerminalOutput(line) + reset;
			if (cache.size >= cap) {
				// FIFO eviction: drop the oldest insertion. Map iteration is insertion-ordered.
				const oldest = cache.keys().next().value;
				if (oldest !== undefined) cache.delete(oldest);
			}
			cache.set(line, normalized);
			nextInput[i] = line;
			nextOutput[i] = normalized;
		}
		// Store back into whichever slot was chosen (even if the guard above forced
		// a fresh allocation this frame, replacing the stale aliased buffer heals
		// the pool for the next frame).
		if (useBufferA) {
			this.resetBufferInputA = nextInput;
			this.resetBufferOutputA = nextOutput;
		} else {
			this.resetBufferInputB = nextInput;
			this.resetBufferOutputB = nextOutput;
		}
		this.resetInputCache = nextInput;
		this.resetOutputCache = nextOutput;
		this.resetFirstDirty = firstDirty;
		return nextOutput;
	}

	/**
	 * Number of entries currently held in the per-line reset cache. Test-only
	 * observability: lets a regression guard assert the cache scales with the
	 * transcript (so a long session keeps ~100% hit-rate instead of thrashing).
	 */
	getDiffScanCountForTest(): number {
		return this.diffScanCountForTest;
	}

	getResetCacheSizeForTest(): number {
		return this.resetCache.size;
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		// extractKittyImageIds already no-ops per line under this guard, but this
		// still has to call it once per line and allocate a fresh Set every frame
		// (called on every render — see fullRender/the diff paths below) just to
		// discover it's empty. Skip straight to the shared empty set instead.
		if (getCapabilities().images !== "kitty") return EMPTY_KITTY_IDS;
		// On Kitty terminals this walk runs over the whole frame at every commit,
		// paying a per-line indexOf scan even though unchanged lines arrive as the
		// same string objects every frame (component memoization — the same
		// contract resetInputCache relies on). Reuse each line's extracted ids via
		// an index-aligned pointer compare against the previous committed frame;
		// only lines whose string identity changed are re-scanned. The two
		// per-line arrays alternate roles each commit (prev ↔ scratch) so no
		// allocation happens in the steady state.
		const prevLines = this.kittyIdsPrevLines;
		const prevPerLine = this.kittyIdsPrevPerLine;
		const nextPerLine = this.kittyIdsNextPerLine;
		nextPerLine.length = lines.length;
		const ids = new Set<number>();
		const prevLen = prevLines.length;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineIds = i < prevLen && prevLines[i] === line ? prevPerLine[i] : extractKittyImageIds(line);
			nextPerLine[i] = lineIds;
			for (let j = 0; j < lineIds.length; j++) {
				ids.add(lineIds[j]);
			}
		}
		this.kittyIdsPrevPerLine = nextPerLine;
		this.kittyIdsNextPerLine = prevPerLine;
		// Safe to hold: this is the array committed as previousLines right after
		// this call, and it is never mutated in place (see applyLineResets' pool
		// alias guard). The next commit replaces this reference wholesale.
		this.kittyIdsPrevLines = lines;
		return ids;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private expandLastChangedForKittyImages(firstChanged: number, lastChanged: number): number {
		// No Kitty images can exist in previousLines on a non-Kitty terminal (see
		// extractKittyImageIds' guard), so the walk below can never find one to
		// expand into — skip it and the per-line call entirely.
		if (getCapabilities().images !== "kitty") return lastChanged;
		let expandedLastChanged = lastChanged;
		for (let i = firstChanged; i < this.previousLines.length; i++) {
			if (extractKittyImageIds(this.previousLines[i]).length > 0) {
				expandedLastChanged = Math.max(expandedLastChanged, i);
			}
		}
		return expandedLastChanged;
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";
		// Same non-Kitty short-circuit as expandLastChangedForKittyImages: nothing
		// in previousLines can hold a Kitty id, so skip the scan.
		if (getCapabilities().images !== "kitty") return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	/** Splice overlay content into a base line at a specific column. Single-pass optimized. */
	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (isImageLine(baseLine)) return baseLine;

		// Single pass through baseLine extracts both before and after segments
		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		// Pad segments to target widths
		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		// Compose result
		const r = TUI.SEGMENT_RESET;
		const result =
			base.before +
			" ".repeat(beforePad) +
			r +
			overlay.text +
			" ".repeat(overlayPad) +
			r +
			base.after +
			" ".repeat(afterPad);

		// CRITICAL: Always verify and truncate to terminal width.
		// This is the final safeguard against width overflow which would crash the TUI.
		// Width tracking can drift from actual visible width due to:
		// - Complex ANSI/OSC sequences (hyperlinks, colors)
		// - Wide characters at segment boundaries
		// - Edge cases in segment extraction
		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return result;
		}
		// Truncate with strict=true to ensure we don't exceed totalWidth
		return sliceByColumn(result, 0, totalWidth, true);
	}

	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	private extractCursorPosition(
		lines: string[],
		height: number,
	): { pos: { row: number; col: number } | null; lines: string[] } {
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// Strip marker into a scratch copy rather than mutating in place: `lines`
				// may be a Container's memoized flatten array (see Container.render).
				// Alternate two scratch buffers so we never overwrite `previousLines`
				// while the differential path still needs it.
				const scratch = this.cursorStripUseA ? this.cursorStripScratchA : this.cursorStripScratchB;
				this.cursorStripUseA = !this.cursorStripUseA;
				if (scratch.length !== lines.length) {
					scratch.length = lines.length;
				}
				for (let i = 0; i < lines.length; i++) {
					scratch[i] = lines[i]!;
				}
				scratch[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { pos: { row, col }, lines: scratch };
			}
		}
		return { pos: null, lines };
	}

	/** Absolute path of the render-overflow diagnostic file. */
	private overflowLogPath(): string {
		return path.join(os.homedir(), ".pit", "agent", "pi-crash.log");
	}

	/**
	 * Snapshot the whole rendered frame as a crash dump just before throwing in
	 * assert mode (PIT_RENDER_ASSERT=1). Production never reaches this — it
	 * truncates and continues — so this stays a dev/CI-only diagnostic and never
	 * touches disk during a normal session. Best-effort: a logging failure must
	 * never escalate into the crash we're trying to make legible.
	 */
	private logRenderOverflow(lineIndex: number, line: string, width: number, allLines: string[]): void {
		// Dump only a window around the offending line: measuring visibleWidth of
		// every transcript line (20k+) made assert-mode crashes take seconds.
		const WINDOW = 25;
		const start = Math.max(0, lineIndex - WINDOW);
		const end = Math.min(allLines.length, lineIndex + WINDOW + 1);
		const data = [
			`Crash at ${new Date().toISOString()}`,
			`Terminal width: ${width}`,
			`Line ${lineIndex} visible width: ${visibleWidth(line)}`,
			"",
			`=== Rendered lines ${start}..${end - 1} of ${allLines.length} ===`,
			...allLines.slice(start, end).map((l, idx) => `[${start + idx}] (w=${visibleWidth(l)}) ${l}`),
			"",
		].join("\n");
		try {
			fs.mkdirSync(path.dirname(this.overflowLogPath()), { recursive: true });
			fs.writeFileSync(this.overflowLogPath(), data);
		} catch {
			// Diagnostics are best-effort; never let a logging failure escalate.
		}
	}

	/** Memoized visibleWidth(line); see the widthCache field comment. */
	private measureWidthCached(line: string, transcriptLen: number): number {
		const cached = this.widthCache.get(line);
		if (cached !== undefined) return cached;
		const w = visibleWidth(line);
		const cap = Math.min(TUI.WIDTH_CACHE_HARD_MAX, Math.max(TUI.WIDTH_CACHE_MIN, transcriptLen * 2));
		if (this.widthCache.size >= cap) {
			// FIFO eviction: drop the oldest insertion. Map iteration is insertion-ordered.
			const oldest = this.widthCache.keys().next().value;
			if (oldest !== undefined) this.widthCache.delete(oldest);
		}
		this.widthCache.set(line, w);
		return w;
	}

	/**
	 * Entries currently held in the per-line width cache. Test-only observability
	 * mirroring getResetCacheSizeForTest().
	 */
	getWidthCacheSizeForTest(): number {
		return this.widthCache.size;
	}

	/**
	 * Last-resort width guard applied to every line just before it reaches the
	 * terminal, on BOTH the differential and full-redraw paths, so neither can
	 * leak an over-wide line. In assert mode (PIT_RENDER_ASSERT=1) it dumps the
	 * frame and throws, so dev/CI catches the offending component (named more
	 * precisely by assertComponentWidth at the component boundary). In production
	 * it truncates and returns: a clipped line for one frame beats crashing the
	 * session mid-task. Image lines pass through (their byte length is not their
	 * visible width).
	 */
	private clampLineToWidth(line: string, lineIndex: number, width: number, allLines: string[]): string {
		if (isImageLine(line) || this.measureWidthCached(line, allLines.length) <= width) return line;
		if (renderAssertEnabled) {
			this.logRenderOverflow(lineIndex, line, width, allLines);
			this.stop(); // Clean up terminal state before throwing.
			throw new Error(
				[
					`Rendered line ${lineIndex} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
					"",
					"This is likely caused by a custom TUI component not truncating its output.",
					"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
					"",
					`Debug log written to: ${this.overflowLogPath()}`,
				].join("\n"),
			);
		}
		return truncateToWidth(line, width, "…");
	}

	private recordRenderFault(kind: RenderFaultKind, error: unknown): void {
		const message = errorToMessage(error);
		const now = performance.now();
		const count =
			this.renderFault?.kind === kind && this.renderFault.message === message ? this.renderFault.count + 1 : 1;
		this.renderFault = {
			kind,
			count,
			message,
			expiresAt: now + RENDER_FAULT_VISIBLE_MS,
		};
		if (this.renderFaultClearTimer) {
			clearTimeout(this.renderFaultClearTimer);
		}
		const delay = Math.max(0, this.renderFault.expiresAt - now + 1);
		this.renderFaultClearTimer = setTimeout(() => {
			this.renderFaultClearTimer = undefined;
			if (this.stopped || this.renderFault === null) return;
			if (this.renderFault.expiresAt > performance.now()) return;
			this.renderFault = null;
			this.requestRender();
		}, delay);
		this.renderFaultClearTimer.unref?.();
	}

	private renderFaultLines(width: number, now: number): string[] {
		if (this.renderFault === null) return [];
		if (this.renderFault.expiresAt <= now) {
			this.renderFault = null;
			return [];
		}
		const label = this.renderFault.kind === "animation" ? "animation error" : "render error";
		const count = this.renderFault.count > 1 ? ` x${this.renderFault.count}` : "";
		// Bold red "!" so the fault stands out from the transcript; body dimmed since
		// it's a raw error message, not primary content. Raw SGR (no theme in this package).
		const prefix = "\x1b[1m\x1b[31m!\x1b[39m\x1b[22m";
		const body = `\x1b[2m${label}${count}: ${this.renderFault.message}\x1b[22m`;
		return [truncateToWidth(`${prefix} ${body}`, width, "…")];
	}

	private doRender(force = false): void {
		// After RENDER_FAULT_EVICT_AFTER consecutive failures, stop auto-retry
		// until the next forced paint (input/resize/requestRender(true)) so a
		// stuck throw cannot pin the event loop at 60fps.
		if (this.renderFaultSuppressed && !force) {
			return;
		}
		try {
			this._doRenderCore(force);
			this.consecutiveRenderFaults = 0;
			this.renderFaultSuppressed = false;
		} catch (error) {
			// doRender runs from a nextTick/timer callback, so a throw from any
			// component render() (markdown, an extension overlay, compositeOverlays)
			// would be an uncaughtException → process death. Skip the bad frame instead;
			// `this.previous*` state is only committed at the end of a successful render,
			// so the next requestRender diffs against the last good frame.
			this.recordRenderFault("render", error);
			this.consecutiveRenderFaults += 1;
			if (this.consecutiveRenderFaults >= TUI.RENDER_FAULT_EVICT_AFTER) {
				this.renderFaultSuppressed = true;
				// One more forced paint so the fault banner is visible; no loop.
				return;
			}
			this.requestRender();
		}
	}

	private _doRenderCore(force = false): void {
		if (this.stopped) return;
		// Backpressure: skip producing/writing a new frame while stdout's buffer is
		// full (a slow consumer — SSH, a piped terminal — would otherwise let frames
		// queue up in process RAM with nothing to bound them). Nothing is lost by
		// skipping: every frame derives from current state, so the next render
		// (triggered here once the stream drains) paints whatever is current then.
		// `force` (resize / requestRender(true)) always bypasses this — those need
		// to paint immediately regardless of backpressure.
		if (!force && this.terminal.isBackpressured?.()) {
			this.renderRequested = true;
			if (!this.drainCallbackRegistered) {
				this.drainCallbackRegistered = true;
				this.terminal.onDrain?.(() => {
					this.drainCallbackRegistered = false;
					this.requestRender();
				});
			}
			return;
		}
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// Render all components to get new lines
		let newLines = this.render(width);
		const faultLines = this.renderFaultLines(width, performance.now());
		if (faultLines.length > 0) {
			newLines = [...newLines, ...faultLines];
		}

		// Composite overlays into the rendered lines (before differential compare)
		if (this.overlayStack.length > 0) {
			newLines = this.compositeOverlays(newLines, width, height);
		}

		// Extract cursor position before applying line resets (marker must be found first).
		// Returns a marker-stripped copy when a marker is present so the source array
		// (possibly a Container flatten cache) is never mutated in place.
		const cursor = this.extractCursorPosition(newLines, height);
		const cursorPos = cursor.pos;
		newLines = cursor.lines;

		newLines = this.applyLineResets(newLines);

		// Helper to repaint every line. clearMode selects how much is wiped first:
		//   "none"   → no clear (first render onto an assumed-clean screen)
		//   "all"    → clear screen + home + clear scrollback (\x1b[3J); for width
		//              changes and shrink, where rewrapped history must not linger
		//   "screen" → clear visible screen + home but KEEP scrollback; for a
		//              height change without a width change, where the wrap is
		//              unchanged so the rolled-up history is still valid and wiping
		//              it (\x1b[3J) would needlessly destroy the user's scrollback
		const fullRender = (clearMode: "none" | "all" | "screen"): void => {
			this.fullRedrawCount += 1;
			const clear = clearMode !== "none";
			const chunkLines = TUI.FULL_RENDER_CHUNK_LINES;
			// Write in chunks so a 20k-line resize never builds one multi-MB string.
			// Sync (no setImmediate) to avoid re-entrancy into the render loop.
			this.terminal.write("\x1b[?2026h");
			if (clear) {
				this.terminal.write(this.deleteKittyImages(this.previousKittyImageIds));
				// Always clear the visible screen + home; only "all" also clears the
				// scrollback (\x1b[3J) so a height-only repaint preserves rollable history.
				// PIT_NO_SCROLLBACK_WIPE=1 opts out of the \x1b[3J itself (pre-session
				// terminal history stays intact); the deliberate default keeps it, since
				// leaving stale rewrapped history behind after a width change is worse.
				const wipeScrollback = clearMode === "all" && process.env.PIT_NO_SCROLLBACK_WIPE !== "1";
				this.terminal.write(wipeScrollback ? "\x1b[2J\x1b[H\x1b[3J" : "\x1b[2J\x1b[H");
			}
			for (let start = 0; start < newLines.length; start += chunkLines) {
				const end = Math.min(start + chunkLines, newLines.length);
				const parts: string[] = [];
				for (let i = start; i < end; i++) {
					if (i > 0) parts.push("\r\n");
					parts.push(this.clampLineToWidth(newLines[i], i, width, newLines));
				}
				this.terminal.write(parts.join(""));
			}
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			// Cursor positioning goes inside the bracket, closed by the same write, so
			// the hardware cursor never lands at end-of-content for one visible frame
			// before jumping to its real (e.g. IME) position.
			this.terminal.write(`${this.positionHardwareCursor(cursorPos, newLines.length)}\x1b[?2026l`);
			// Reset max lines when clearing, otherwise track growth
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			const bufferLength = Math.max(height, newLines.length);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
		};

		const debugRedraw = process.env.PIT_DEBUG_REDRAW === "1";
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			const logPath = path.join(os.homedir(), ".pit", "agent", "pit-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			fs.appendFileSync(logPath, msg);
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender("none");
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) {
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			fullRender("all");
			return;
		}

		// Height changes need a full repaint to keep the visible viewport aligned, but
		// the wrap is unchanged (width held), so the rolled-up scrollback is still
		// valid — repaint with "screen" (clear visible screen, KEEP scrollback) instead
		// of "all" (\x1b[3J wipes history). Termux toggles height when the soft keyboard
		// shows/hides and is handled fully differentially below (no repaint at all), so
		// this branch is for the non-Termux case; both now preserve scrollback.
		if (heightChanged && !isTermuxSession()) {
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			fullRender("screen");
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink() or PIT_CLEAR_ON_SHRINK=0 env var
		if (this.clearOnShrink && newLines.length < this.maxLinesRendered && this.overlayStack.length === 0) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender("all");
			return;
		}

		// Find first and last changed lines. Prefer resetFirstDirty from
		// applyLineResets so spinner/tail ticks skip an O(N) prefix scan.
		let firstChanged = -1;
		let lastChanged = -1;
		const prevLen = this.previousLines.length;
		const newLen = newLines.length;
		const maxLines = Math.max(newLen, prevLen);
		const resetDirty = this.resetFirstDirty;
		this.diffScanCountForTest = 0;
		if (
			prevLen === newLen &&
			prevLen > 0 &&
			resetDirty === newLen - 1 &&
			this.previousLines[prevLen - 1] !== newLines[newLen - 1]
		) {
			firstChanged = prevLen - 1;
			lastChanged = prevLen - 1;
		} else if (prevLen === newLen && prevLen > 0 && this.previousLines[prevLen - 1] !== newLines[newLen - 1]) {
			let onlyLastLine = true;
			for (let i = 0; i < prevLen - 1; i++) {
				this.diffScanCountForTest += 1;
				if (this.previousLines[i] !== newLines[i]) {
					onlyLastLine = false;
					break;
				}
			}
			if (onlyLastLine) {
				firstChanged = prevLen - 1;
				lastChanged = prevLen - 1;
			}
		}
		if (firstChanged === -1) {
			const scanFrom = Math.min(Math.max(0, resetDirty), maxLines);
			for (let i = scanFrom; i < maxLines; i++) {
				this.diffScanCountForTest += 1;
				const oldLine = i < prevLen ? this.previousLines[i] : "";
				const newLine = i < newLen ? newLines[i] : "";
				if (oldLine !== newLine) {
					firstChanged = i;
					break;
				}
			}
			// Prefix before scanFrom is known-stable from applyLineResets when
			// lengths match; if scanFrom > 0 and nothing differed after, treat as
			// no change unless lengths differ (handled by appendedLines below).
			if (firstChanged === -1 && scanFrom > 0 && prevLen === newLen) {
				// nothing changed after the known-dirty index — no-op frame
			} else if (firstChanged === -1 && scanFrom > 0 && prevLen !== newLen) {
				firstChanged = scanFrom;
			}
			if (firstChanged !== -1) {
				for (let i = maxLines - 1; i >= firstChanged; i--) {
					this.diffScanCountForTest += 1;
					const oldLine = i < prevLen ? this.previousLines[i] : "";
					const newLine = i < newLen ? newLines[i] : "";
					if (oldLine !== newLine) {
						lastChanged = i;
						break;
					}
				}
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		if (firstChanged !== -1) {
			lastChanged = this.expandLastChangedForKittyImages(firstChanged, lastChanged);
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			const cursorEscape = this.positionHardwareCursor(cursorPos, newLines.length);
			if (cursorEscape) this.terminal.write(cursorEscape);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				let buffer = "\x1b[?2026h";
				buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLines.length - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					fullRender("all");
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				// Clear extra lines without scrolling
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender("all");
					return;
				}
				if (extraLines > 0) {
					buffer += "\x1b[1B";
				}
				for (let i = 0; i < extraLines; i++) {
					buffer += "\r\x1b[2K";
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				if (extraLines > 0) {
					buffer += `\x1b[${extraLines}A`;
				}
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
				buffer += this.positionHardwareCursor(cursorPos, newLines.length);
				buffer += "\x1b[?2026l";
				this.terminal.write(buffer);
			} else {
				const cursorEscape = this.positionHardwareCursor(cursorPos, newLines.length);
				if (cursorEscape) this.terminal.write(cursorEscape);
			}
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			return;
		}

		// Differential rendering can only touch what was actually visible.
		// If the first changed line is above the previous viewport, we need a full redraw.
		if (firstChanged < prevViewportTop) {
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			fullRender("all");
			return;
		}

		// Render from first changed line to end
		// Build buffer with all updates wrapped in synchronized output
		const parts: string[] = ["\x1b[?2026h"];
		parts.push(this.deleteChangedKittyImages(firstChanged, lastChanged));
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				parts.push(`\x1b[${moveToBottom}B`);
			}
			const scroll = moveTargetRow - prevViewportBottom;
			parts.push("\r\n".repeat(scroll));
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			parts.push(`\x1b[${lineDiff}B`);
		} else if (lineDiff < 0) {
			parts.push(`\x1b[${-lineDiff}A`);
		}

		parts.push(appendStart ? "\r\n" : "\r");

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) parts.push("\r\n");
			parts.push("\x1b[2K");
			parts.push(this.clampLineToWidth(newLines[i], i, width, newLines));
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				parts.push(`\x1b[${moveDown}B`);
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				parts.push("\r\n\x1b[2K");
			}
			// Move cursor back to end of new content
			parts.push(`\x1b[${extraLines}A`);
		}

		// Set the field before building the cursor escape - positionHardwareCursor moves
		// from this.hardwareCursorRow, which must already reflect where this frame's
		// content writes land the cursor (finalCursorRow), not its pre-frame value.
		this.hardwareCursorRow = finalCursorRow;
		// Cursor positioning goes inside the bracket, closed in the same buffer, so the
		// hardware cursor never lands at end-of-content for one visible frame before
		// jumping to its real (e.g. IME) position.
		parts.push(this.positionHardwareCursor(cursorPos, newLines.length));
		parts.push("\x1b[?2026l");
		const buffer = parts.join("");

		if (process.env.PIT_TUI_DEBUG === "1") {
			const debugDir = "/tmp/tui";
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const metaLines = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				`buffer.length: ${buffer.length}`,
			];
			// Full frame dump only when explicitly requested — stringify of every
			// line is expensive on the render hot path.
			const debugData =
				process.env.PIT_TUI_DEBUG_FULL === "1"
					? [
							...metaLines,
							"",
							"=== newLines ===",
							JSON.stringify(newLines),
							"",
							"=== previousLines ===",
							JSON.stringify(this.previousLines),
							"",
							"=== buffer ===",
							JSON.stringify(buffer),
						].join("\n")
					: metaLines.join("\n");
			void fs.promises.mkdir(debugDir, { recursive: true }).then(() => fs.promises.writeFile(debugPath, debugData));
		}

		// Write entire buffer at once
		this.terminal.write(buffer);

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		// (already set to finalCursorRow above, before building the cursor escape)
		this.cursorRow = Math.max(0, newLines.length - 1);
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		this.previousLines = newLines;
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
	}

	/**
	 * Build the escape sequence that positions the hardware cursor for the IME
	 * candidate window (movement + show/hide). Returns the sequence instead of
	 * writing it directly so callers splice it into the current frame's buffer,
	 * inside the \x1b[?2026h/l synchronized-update bracket - writing it as a
	 * separate post-bracket write let the hardware cursor visibly land at the
	 * end of the content for one frame before jumping to the editor.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): string {
		if (!cursorPos || totalLines <= 0) {
			return this.cursorVisibilityEscape(false);
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		buffer += `\x1b[${targetCol + 1}G`;

		this.hardwareCursorRow = targetRow;
		return buffer + this.cursorVisibilityEscape(this.showHardwareCursor);
	}

	// Only emit \x1b[?25h/l when visibility actually changes; every frame calls
	// positionHardwareCursor, and re-sending the same mode on each one is pure waste.
	private cursorVisibilityEscape(visible: boolean): string {
		if (this.hardwareCursorVisible === visible) return "";
		this.hardwareCursorVisible = visible;
		return visible ? "\x1b[?25h" : "\x1b[?25l";
	}
}
