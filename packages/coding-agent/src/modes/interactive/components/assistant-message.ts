import type { ThinkingLevel } from "@pit/agent-core";
import type { AssistantMessage } from "@pit/ai";
import {
	type Component,
	Container,
	HEARTBEAT_CYCLE_MS,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	VirtualizedContainer,
	visibleWidth,
} from "@pit/tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { isReducedMotion } from "../../../utils/env-flags.ts";
import { sliceSafe } from "../../../utils/surrogate.ts";
import { interpolateFg } from "../theme/color-interpolation.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { ColorEase } from "./color-ease.ts";
import { MessageShell, SHELL_GUTTER_CHAR } from "./message-shell.ts";
import { ReadingColumn } from "./reading-column.ts";

// Period of the "Thinking…" breathing oscillation (dim ⇄ normal) while the model
// is mid-thought with no answer yet. Shares the unified @pit/tui
// HEARTBEAT_CYCLE_MS so the label breathes in lockstep with the working-loader
// spinner pulse (both derive phase from the same monotonic clock).
const THINKING_BREATH_MS = HEARTBEAT_CYCLE_MS;
const THINKING_BREATH_BUCKETS = 16;

// Streaming smoothing (on by default): instead of painting each provider burst
// whole, the trailing block's text is revealed at a steady rate off the shared
// animation ticker. The cursor catches up to the streamed backlog in
// ~REVEAL_CATCHUP_FRAMES frames so it never lags far behind on long bursts,
// while a slow drip still advances at least REVEAL_MIN_STEP chars/frame and a big
// burst is capped to REVEAL_MAX_STEP so it eases in instead of snapping.
const REVEAL_CATCHUP_FRAMES = 8; // ~130ms to absorb a burst at 60fps
const REVEAL_MIN_STEP = 1;
const REVEAL_MAX_STEP = 48; // ~3000 cps at 62fps — above any model's emit rate
const REVEAL_FRAME_MS = 16;
/**
 * Provider deltas at or below this size render immediately (single-token snappy).
 * Larger bursts ease in via the ticker — was 80, which snapped multi-word chunks
 * and made streaming read as blocks instead of a smooth wavefront.
 */
const REVEAL_SNAP_THROUGH_CHARS = 12;
// Width (cols) of the dim→bright gradient drawn at the reveal wavefront so freshly
// revealed text materializes softly instead of popping in at full brightness.
const REVEAL_FADE_COLUMNS = 6;

/**
 * Default reading-column cap (in columns) for assistant prose. A positive value
 * wraps long answers at that measure instead of running edge to edge; tool
 * output, bash, and code blocks are never capped. Overridable per-session via
 * the `assistantReadingColumns` setting (SettingsManager.getAssistantReadingColumns),
 * threaded in through the constructor; this constant is the fallback when no
 * value is supplied. Set the setting to `0` for full-width prose.
 */
const DEFAULT_ASSISTANT_READING_COLUMNS = 100;

// FTCS / OSC 133 semantic output zone. The assistant response is the "command
// output": C (output start) … D;<exit> (finished). The user message carries the
// prompt zone (A … B) — see user-message.ts, which also documents why prompt
// and output were split and the first + last line survival invariant. The
// exit status lets a terminal color the prompt mark by turn outcome.
const OSC133_OUTPUT_START = "\x1b]133;C\x07"; // FTCS C: command output start

/**
 * A cached, persistent renderer for a single visible content block (text or
 * thinking), keyed by its position in `message.content`.
 *
 * Keeping the `Markdown` instance alive across `updateContent()` calls is what
 * makes streaming cheap: `Markdown.setText()` invalidates only the flat render
 * cache while preserving the per-token `tokenLineCache`, so appending a chunk
 * re-renders only the trailing (mutated) token instead of re-lexing and
 * re-highlighting the whole buffer on every delta (the old `clear()` + `new
 * Markdown(...)` path was O(n²) per message). The `ReadingColumn` wrapper is
 * reused too — its child is fixed at construction, but the child here never
 * changes, so the wrapper stays valid.
 */
interface BlockComponentCacheEntry {
	kind: "text" | "thinking";
	markdown: Markdown;
	/** ReadingColumn for text; MessageShell(ReadingColumn) for visible thinking. */
	component: Component;
}

// Grapheme-aware splitter for the reveal-edge fade, so the gradient is applied
// per cluster (never splitting a combining mark or emoji ZWJ sequence).
const FADE_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Memoized "Thinking…" label: stable array identity per breath bucket + width. */
class ThinkingLabelComponent {
	private cachedBucket = -1;
	private cachedWidth = -1;
	private cachedLines: string[] | null = null;
	private readonly getLabel: () => string;
	private readonly getBreathT: () => number;
	private readonly getGutterColor: () => (text: string) => string;

	constructor(getLabel: () => string, getBreathT: () => number, getGutterColor: () => (text: string) => string) {
		this.getLabel = getLabel;
		this.getBreathT = getBreathT;
		this.getGutterColor = getGutterColor;
	}

	render(width: number): string[] {
		const breathT = this.getBreathT();
		const bucket = Math.floor(breathT * THINKING_BREATH_BUCKETS);
		if (bucket === this.cachedBucket && width === this.cachedWidth && this.cachedLines !== null) {
			return this.cachedLines;
		}
		const t = breathT < 0.15 ? 0.15 : breathT;
		const c = interpolateFg("dim", "thinkingText", t) ?? ((text: string) => theme.fg("thinkingText", text));
		const label = this.getLabel();
		const gutter = this.getGutterColor()(SHELL_GUTTER_CHAR);
		this.cachedBucket = bucket;
		this.cachedWidth = width;
		this.cachedLines = [truncateToWidth(`${gutter} ${theme.italic(c(label))}`, Math.max(1, width), "…")];
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedBucket = -1;
		this.cachedWidth = -1;
		this.cachedLines = null;
	}
}

/**
 * Discrete bright→dim ramp for terminals without truecolor. Three theme stops
 * so the wavefront still reads as a soft materialize instead of a flat dim snap.
 */
export function discreteFadeTailColorize(t: number): (s: string) => string {
	if (t < 1 / 3) return (s: string) => theme.fg("text", s);
	if (t < 2 / 3) return (s: string) => theme.fg("muted", s);
	return (s: string) => theme.fg("dim", s);
}

function fadeTailColorize(t: number): (s: string) => string {
	return interpolateFg("text", "dim", t) ?? discreteFadeTailColorize(t);
}

/**
 * Recolor the trailing text of a rendered line as a bright→dim gradient, landing
 * on the real text edge (right padding is preserved untouched) and keeping the
 * line's visible characters and width identical — only colors change, so callers
 * that strip ANSI see no difference. The newest (rightmost) graphemes are dimmest,
 * easing up to full brightness toward the settled text on the left. Truecolor uses
 * interpolateFg; 256-color falls back to a text→muted→dim discrete ramp.
 */
export function fadeLineTail(line: string): string {
	const totalCols = visibleWidth(line);
	if (totalCols === 0) return line;
	const plain = stripAnsi(line);
	const trimmed = plain.replace(/\s+$/, "");
	const contentCols = visibleWidth(trimmed);
	if (contentCols === 0) return line; // padding / blank only — nothing to fade
	const graphemes = [...FADE_SEGMENTER.segment(trimmed)].map((s) => s.segment);
	const k = Math.min(REVEAL_FADE_COLUMNS, graphemes.length);
	const tailG = graphemes.slice(graphemes.length - k);
	const tailCols = visibleWidth(tailG.join(""));
	const head = truncateToWidth(line, Math.max(0, contentCols - tailCols), "");
	let tail = "";
	for (let i = 0; i < tailG.length; i++) {
		const t = tailG.length <= 1 ? 1 : i / (tailG.length - 1); // left bright → right dim
		tail += fadeTailColorize(t)(tailG[i]);
	}
	const pad = " ".repeat(Math.max(0, totalCols - contentCols));
	return `${head}\x1b[0m${tail}${pad}`;
}

/** Dim block caret at the reveal wavefront, inserted before trailing padding.
 * When padding exists, one pad column is consumed so the line width stays stable. */
export function appendRevealCaret(line: string): string {
	const totalCols = visibleWidth(line);
	if (totalCols === 0) return `${theme.fg("dim", "▌")}`;
	const plain = stripAnsi(line);
	const trimmed = plain.replace(/\s+$/, "");
	const contentCols = visibleWidth(trimmed);
	if (contentCols === 0) return line;
	const padCols = Math.max(0, totalCols - contentCols);
	const caret = theme.fg("dim", "▌");
	const withoutPad = truncateToWidth(line, contentCols, "");
	if (padCols > 0) {
		return `${withoutPad}${caret}${" ".repeat(padCols - 1)}`;
	}
	return `${withoutPad}${caret}`;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: VirtualizedContainer;
	private hideThinkingBlock: boolean;
	private thinkingLevel: ThinkingLevel;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	// Persistent Markdown/ReadingColumn instances keyed by content-block index.
	// Reused across streaming deltas so the trailing block's tokenLineCache
	// survives; only recreated when the block at that index changes kind.
	private blockComponents: (BlockComponentCacheEntry | undefined)[] = [];
	// Streaming-smoothing state. `ui` provides the animation ticker; absent for
	// non-streaming (history) instances, which always reveal whole. `revealIndex`
	// is the content-block currently being revealed (-1 = none / reveal all);
	// `revealedChars` is how much of that block is shown.
	private readonly ui?: TUI;
	private readonly smoothing: boolean;
	// Reading-column cap (cols) for prose width: >0 caps prose to that many
	// columns, 0 = full terminal width (no cap). Read once at construction.
	private readonly readingColumns: number;
	private revealIndex = -1;
	private revealedChars = Number.POSITIVE_INFINITY;
	private lastRevealTarget = 0;
	private lastRevealTickAt = 0;
	private revealUnsub: (() => void) | null = null;
	// False while a live stream block exists but grouped mode has not yet attached
	// it to the chat (thinking-only / pre-text). Prevents invisible reveal catch-up
	// and keeps clampReveal from dumping the full buffer on first paint.
	private streamVisible = true;
	// Decorated-output memo keyed by the Container's returned array reference plus
	// the dynamic-decoration inputs (deliverable flag + exit code). Container.render
	// is memoized and hands back the same array instance while no child changed
	// (Component render contract); re-slicing + re-decorating it every frame would
	// allocate a fresh array each tick and defeat the parent Container's flatten
	// cache (childLines !== the cached ref → O(lines) re-flatten per animation
	// frame, including history off-screen). We may only reuse the memo when BOTH
	// per-frame decorations are inactive: the reveal-edge fade (settled) and the
	// deliverable ColorEase (not animating). While either is live the decoration
	// changes every frame, so we fall through to the recompute path and skip caching.
	private decorateSource: string[] | null = null;
	private decorated: string[] | null = null;
	private decoratedDeliverable = false;
	private decoratedExitCode = -1;
	// Double-buffered scratch for the per-frame decorated output. While a decoration
	// animates (reveal-edge fade or deliverable-glyph ease) the memo above cannot be
	// reused, so render() must copy `rendered` and decorate the copy every frame —
	// `rendered` is the parent Container's memoized flatten array, which the
	// Component render contract forbids mutating in place. `rendered.slice()` would
	// allocate a fresh L-slot array each animation tick (~60fps); instead we
	// alternate between two reusable buffers, mirroring the resetBuffer/
	// collectKittyImageIds double-buffers in tui.ts. Two buffers suffice: the parent
	// detects "this child changed" purely by the returned array's reference identity
	// (Container.render: `childLines !== cached ref`), so we must return a DIFFERENT
	// reference than last frame while the content genuinely changes, yet never mutate
	// the array the parent still holds. `decorFillA` always points away from the
	// buffer we last filled/returned, so filling it satisfies both. (Option (a) — one
	// persistent array mutated in place and returned by the same reference — would be
	// missed by that identity check and freeze the animation, so it is unsafe here.)
	private decorBufferA: string[] = [];
	private decorBufferB: string[] = [];
	private decorFillA = true;
	// Deliverable-marker state
	private isDeliverable = false;
	// Dim the prose: set on intermediate (non-deliverable) turn messages so step
	// narration recedes behind the marked final answer.
	private isNarration = false;
	// Eased brighten→settle of the deliverable ● (null until marked / no ui).
	private deliverableEase: ColorEase | null = null;
	// Continuous breathing of the hidden "Thinking…" label while it is the latest
	// content (model still thinking, no answer yet).
	private breathUnsub: (() => void) | null = null;
	private breathStart = 0;
	private breathT = 0;
	private breathBucket = -1;
	private readonly thinkingLabel = new ThinkingLabelComponent(
		() => this.hiddenThinkingLabel,
		() => this.breathT,
		() => theme.getThinkingBorderColor(this.thinkingLevel),
	);
	// Fingerprint of the last built child-tree layout. When a stream delta only
	// grows text inside existing blocks, patchContent() updates markdown in place
	// instead of contentContainer.clear() + full rebuild.
	private lastStructureKey = "";
	// Set by freeze() once this message has settled. Actioned lazily in render()
	// (see maybeFreezeMarkdown): the caller requests the freeze at message_end, but
	// the final full-text render can lag settle by a few frames under streaming
	// smoothing, so we wait until the component is genuinely static before dropping
	// the Markdown streaming caches. Stays true after firing so a later grouped-mode
	// narration rebuild (which swaps in fresh Markdown instances) gets re-frozen.
	private freezeRequested = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking…",
		ui?: TUI,
		smoothing = false,
		readingColumns: number = DEFAULT_ASSISTANT_READING_COLUMNS,
		thinkingLevel: ThinkingLevel = "off",
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.thinkingLevel = thinkingLevel;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.ui = ui;
		this.smoothing = smoothing;
		// >0 caps prose to that many columns; 0 / non-positive = full width (no cap).
		this.readingColumns = readingColumns > 0 ? readingColumns : 0;

		// Virtualized container: settled blocks above the tail skip re-render each frame.
		this.contentContainer = new VirtualizedContainer();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setThinkingLevel(level: ThinkingLevel): void {
		if (level === this.thinkingLevel) return;
		this.thinkingLevel = level;
		this.thinkingLabel.invalidate();
		// Bust thinking-block shells so gutter color refreshes; text blocks stay.
		for (let i = 0; i < this.blockComponents.length; i++) {
			const entry = this.blockComponents[i];
			if (entry?.kind === "thinking") {
				this.blockComponents[i] = undefined;
			}
		}
		this.lastStructureKey = "";
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		this.thinkingLabel.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/** Toggle whether this live stream is mounted in the chat. Grouped tool-activity
	 * mode defers attach until the message has visible prose; while detached the
	 * reveal cursor stays at zero so text does not catch up off-screen. */
	setStreamVisible(visible: boolean): void {
		if (this.streamVisible === visible) return;
		this.streamVisible = visible;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
		this.ui?.requestRender();
	}

	/** True when neither per-frame decoration is live, so the decorated output is
	 * stable across frames and safe to memoize. The reveal-edge fade is active only
	 * while the trailing block is still revealing (mirrors applyRevealEdgeFade's own
	 * guard); the deliverable glyph recolors only while its ColorEase animates. */
	private decorationIsStatic(): boolean {
		if (this.smoothing && this.revealIndex >= 0 && this.lastMessage) {
			const target = this.blockTextLength(this.lastMessage, this.revealIndex);
			if (this.revealedChars < target) return false; // reveal fade still live
		}
		if (this.deliverableEase?.active) return false; // glyph ease still animating
		return true;
	}

	override render(width: number): string[] {
		const rendered = super.render(width);
		// super.render() just rendered every Markdown child, so their final line
		// caches are populated for this (text, width). If a freeze was requested and
		// the message has fully settled, release the Markdown streaming/lex caches
		// now — deferring to here (rather than the message_end call site) is required
		// because streaming smoothing reveals the tail a few frames after settle, so
		// the final full-text render may not have happened yet at that call.
		this.maybeFreezeMarkdown();
		if (this.hasToolCalls || rendered.length === 0) {
			return rendered;
		}

		// Exit status on D: aborted turns report 130 (SIGINT), errored turns 1,
		// everything else 0. Recomputed each frame; the final settled render
		// carries the true code.
		const stop = this.lastMessage?.stopReason;
		const exitCode = stop === "aborted" ? 130 : stop === "error" ? 1 : 0;

		// Reuse the decorated memo when the underlying Container array is the same
		// instance AND the dynamic decoration inputs (deliverable flag, exit code)
		// match what we cached AND no per-frame decoration is live. This keeps the
		// returned array identity-stable for the parent's flatten cache while the
		// animation ticker fires, instead of allocating a fresh decorated array per
		// frame. Recomputed below (and re-cached) whenever any of these differ.
		if (
			rendered === this.decorateSource &&
			this.decorated !== null &&
			this.decoratedDeliverable === this.isDeliverable &&
			this.decoratedExitCode === exitCode &&
			this.decorationIsStatic()
		) {
			return this.decorated;
		}

		// Copy before decorating: Container.render hands back its memoized array
		// (the same instance while no child changed), and the Component render
		// contract forbids mutating an already-returned array. Decorating in
		// place would bake the OSC 133 markers / deliverable glyph into that
		// cache and re-apply them on every steady-state frame (accumulating
		// markers and growing the line past the terminal width).
		//
		// Reuse an alternating scratch buffer instead of rendered.slice() so this
		// per-frame copy allocates nothing during the animation. decorFillA points
		// at the buffer we did NOT return last frame, so filling it hands the parent
		// a fresh reference (its change signal) without touching the array it still
		// holds. It flips only here, on an actual fill.
		const lines = this.decorFillA ? this.decorBufferA : this.decorBufferB;
		this.decorFillA = !this.decorFillA;
		lines.length = rendered.length;
		for (let i = 0; i < rendered.length; i++) {
			lines[i] = rendered[i];
		}

		// Soft wavefront: while the trailing block is still revealing, fade its
		// growing edge so freshly streamed text materializes instead of popping.
		this.applyRevealEdgeFade(lines);

		if (this.isDeliverable && this.hasVisibleTextBlock()) {
			const glyph = this.deliverableEase ? this.deliverableEase.colorize("accent", "●") : theme.fg("accent", "●");
			for (let i = 0; i < lines.length; i++) {
				if (visibleWidth(stripAnsi(lines[i])) > 0) {
					lines[i] = `${glyph} ${lines[i]}`;
					// Prepending "● " adds 2 cols without re-truncating. With
					// readingColumns=0 the prose already fills the full width, so the
					// marked line can spill to width+2. Downstream clampLineToWidth would
					// catch it (and truncate to the same `truncateToWidth(line, width, "…")`),
					// but under PIT_RENDER_ASSERT it throws instead. Re-truncate here to the
					// identical result so the assert never trips; the common case (line fits)
					// short-circuits and is byte-identical.
					if (visibleWidth(stripAnsi(lines[i])) > width) {
						lines[i] = truncateToWidth(lines[i], width, "…");
					}
					break;
				}
			}
		}

		lines[0] = OSC133_OUTPUT_START + lines[0];
		lines[lines.length - 1] = `${lines[lines.length - 1]}\x1b]133;D;${exitCode}\x07`;

		// Cache the decorated array for identity-stable reuse on subsequent frames —
		// but only when no per-frame decoration is live, so the memo can't pin a
		// stale fade/glyph frame. While a decoration animates we leave the previous
		// memo untouched (and the guard above won't hit it, since decorationIsStatic
		// is false), recomputing fresh every frame as before.
		if (this.decorationIsStatic()) {
			this.decorateSource = rendered;
			this.decorated = lines;
			this.decoratedDeliverable = this.isDeliverable;
			this.decoratedExitCode = exitCode;
		}
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;
		this.syncReveal(message);
		if (!this.patchContentIfPossible()) {
			this.rebuildContent();
		}
	}

	/**
	 * Rebuild the content container from `this.lastMessage`, honoring the reveal
	 * cursor when streaming smoothing is active (the trailing block is clamped to
	 * `revealedChars`). Pure with respect to the animation ticker — it never
	 * subscribes or unsubscribes, so the ticker can call it every frame safely.
	 */
	/** Layout fingerprint: which blocks/spacers/footer children exist. Text growth
	 * inside an unchanged layout skips clear()+rebuild via patchContent(). */
	private computeStructureKey(message: AssistantMessage): string {
		const parts: string[] = [
			`n:${message.content.length}`,
			`ht:${this.hideThinkingBlock ? 1 : 0}`,
			`tl:${this.thinkingLevel}`,
			`nar:${this.isNarration ? 1 : 0}`,
			`sr:${message.stopReason ?? ""}`,
		];
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		parts.push(`tc:${hasToolCalls ? 1 : 0}`);

		let lastVisibleIndex = -1;
		for (let i = 0; i < message.content.length; i++) {
			const c = message.content[i];
			if ((c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim())) {
				lastVisibleIndex = i;
			}
		}
		parts.push(`hv:${lastVisibleIndex >= 0 ? 1 : 0}`);

		for (let i = 0; i < message.content.length; i++) {
			const c = message.content[i];
			if (c.type === "text" && c.text.trim()) {
				parts.push(`${i}:text`);
			} else if (c.type === "thinking" && c.thinking.trim()) {
				if (!this.hideThinkingBlock) {
					const hasAfter = i < lastVisibleIndex;
					parts.push(`${i}:thinking${hasAfter ? ":sp" : ""}`);
				} else {
					const live = i === lastVisibleIndex && !!this.ui && !this.isDeliverable && !message.stopReason;
					if (live) parts.push(`${i}:think-label`);
				}
			}
		}

		if (!hasToolCalls) {
			if (message.stopReason === "aborted") parts.push("foot:abort");
			else if (message.stopReason === "error") parts.push("foot:error");
		}
		return parts.join("|");
	}

	/** Update visible markdown blocks in place when the child-tree layout is unchanged. */
	private patchContentIfPossible(): boolean {
		const message = this.lastMessage;
		if (!message || this.contentContainer.children.length === 0) return false;

		const structureKey = this.computeStructureKey(message);
		if (structureKey !== this.lastStructureKey) return false;

		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				const text = this.clampReveal(i, content.text.trim());
				const entry = this.blockComponents[i];
				if (!entry || entry.kind !== "text") return false;
				entry.markdown.setText(text);
				this.contentContainer.markChildStale(entry.component);
			} else if (content.type === "thinking" && content.thinking.trim() && !this.hideThinkingBlock) {
				const thinking = this.clampReveal(i, content.thinking.trim());
				const entry = this.blockComponents[i];
				if (!entry || entry.kind !== "thinking") return false;
				entry.markdown.setText(thinking);
				this.contentContainer.markChildStale(entry.component);
			}
		}

		if (this.blockComponents.length > message.content.length) {
			this.blockComponents.length = message.content.length;
		}

		this.hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.decorateSource = null;
		this.decorated = null;
		return true;
	}

	private rebuildContent(): void {
		const message = this.lastMessage;
		if (!message) return;

		// Clear content container
		this.contentContainer.clear();

		// Index of the last visible (non-empty text/thinking) block. Computed once
		// here so the per-block "is there a visible block after me?" check below is
		// an O(1) index compare instead of an O(n) slice().some() per iteration
		// (which made rebuild O(n²) in block count on every stream delta). Note this
		// measures the *full* text, so the layout (which blocks exist) is stable
		// while the reveal cursor only clamps the displayed characters.
		let lastVisibleIndex = -1;
		for (let i = 0; i < message.content.length; i++) {
			const c = message.content[i];
			if ((c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim())) {
				lastVisibleIndex = i;
			}
		}
		const hasVisibleContent = lastVisibleIndex !== -1;
		let sawLiveThinking = false;

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order. Reuse the persistent Markdown/ReadingColumn for
		// block index `i` when it is still the same kind ("text"/"thinking"); call
		// setText() to preserve its tokenLineCache instead of re-allocating. Only
		// recreate the slot when the kind at that index changed (structural change).
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				const text = this.clampReveal(i, content.text.trim());
				let entry = this.blockComponents[i];
				if (entry?.kind === "text" && !this.isNarration) {
					entry.markdown.setText(text);
				} else {
					const markdown = this.makeProseMarkdown(text);
					entry = {
						kind: "text",
						markdown,
						component: new ReadingColumn(markdown, this.readingColumns),
					};
					this.blockComponents[i] = entry;
				}
				this.contentContainer.addChild(entry.component);
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = i < lastVisibleIndex;

				if (this.hideThinkingBlock) {
					// Hidden-thinking mode. Drop any cached Markdown at this slot so a
					// later un-hide rebuilds it fresh.
					this.blockComponents[i] = undefined;
					// Only the LIVE thinking block — the latest content of the still
					// in-flight turn, with a ui to animate on — shows an in-transcript
					// breathing "Thinking…" label. Thinking blocks from settled turns render
					// nothing: the single footer working loader is the only "Thinking…"
					// indicator, so finished turns don't litter the transcript with
					// identical-looking stale labels (which read as if several "current"
					// thoughts were live at once).
					// `!message.stopReason` keeps the breath from re-arming once the turn
					// settles/aborts (otherwise an aborted thinking-only turn leaks a
					// forever-running ticker that pins the component).
					const live = i === lastVisibleIndex && !!this.ui && !this.isDeliverable && !message.stopReason;
					if (live) {
						sawLiveThinking = true;
						this.startThinkingBreath();
						this.contentContainer.addChild(this.thinkingLabel);
					}
					// Settled thinking blocks render nothing (see above); the footer working
					// loader is the only live "Thinking…". No spacer either, so following
					// content (the assistant's text/answer) stays flush.
				} else {
					// Thinking traces in thinkingText color, italic, with a level-tinted gutter
					const thinking = this.clampReveal(i, content.thinking.trim());
					let entry = this.blockComponents[i];
					if (entry?.kind === "thinking") {
						entry.markdown.setText(thinking);
						if (entry.component instanceof MessageShell) {
							entry.component.setGutterColor(theme.getThinkingBorderColor(this.thinkingLevel));
						}
					} else {
						const markdown = new Markdown(thinking, 1, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						});
						const column = new ReadingColumn(markdown, this.readingColumns);
						const shell = new MessageShell({
							gutterColor: theme.getThinkingBorderColor(this.thinkingLevel),
							noLeadingGap: true,
						});
						shell.addChild(column);
						entry = {
							kind: "thinking",
							markdown,
							component: shell,
						};
						this.blockComponents[i] = entry;
					}
					this.contentContainer.addChild(entry.component);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			} else {
				// Non-visible / non-text block at this index (e.g. toolCall, image,
				// empty text). Invalidate any cached renderer here so a future text or
				// thinking block at the same index doesn't reuse a stale instance.
				this.blockComponents[i] = undefined;
			}
		}

		// No live thinking label this rebuild (answer arrived, or no hidden thinking)
		// → stop the breathing ticker. Kept running across rebuilds while still live
		// (startThinkingBreath is a no-op when already running, so the phase is stable).
		if (!sawLiveThinking) this.stopThinkingBreath();

		// Trim cache entries past the current block count (message shrank / blocks removed).
		if (this.blockComponents.length > message.content.length) {
			this.blockComponents.length = message.content.length;
		}

		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				// Separate the abort notice from real content only when some exists;
				// with nothing visible above, skip the orphan blank line.
				if (hasVisibleContent) {
					this.contentContainer.addChild(new Spacer(1));
				}
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				if (hasVisibleContent) {
					this.contentContainer.addChild(new Spacer(1));
				}
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			}
		}

		this.lastStructureKey = this.computeStructureKey(message);
	}

	/** Clamp a block's text to the reveal cursor when it is the block currently
	 * being smoothed; otherwise return it whole. */
	private clampReveal(index: number, text: string): string {
		if (this.revealIndex !== index || this.revealedChars >= text.length) return text;
		return sliceSafe(text, 0, this.revealedChars);
	}

	/** Fade the wavefront line's trailing edge while the trailing block is still
	 * revealing, and plant a dim caret at the live edge. No-op when smoothing is
	 * off or the block is fully shown. */
	private applyRevealEdgeFade(lines: string[]): void {
		if (!this.smoothing || this.revealIndex < 0 || !this.lastMessage) return;
		const target = this.blockTextLength(this.lastMessage, this.revealIndex);
		if (this.revealedChars >= target) return; // settled — no live edge to fade
		for (let i = lines.length - 1; i >= 0; i--) {
			if (visibleWidth(lines[i]) > 0) {
				lines[i] = appendRevealCaret(fadeLineTail(lines[i]));
				return;
			}
		}
	}

	private lastVisibleBlockIndex(message: AssistantMessage): number {
		let idx = -1;
		for (let i = 0; i < message.content.length; i++) {
			const c = message.content[i];
			if ((c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim())) {
				idx = i;
			}
		}
		return idx;
	}

	private blockTextLength(message: AssistantMessage, index: number): number {
		const c = message.content[index];
		if (c?.type === "text") return c.text.trim().length;
		if (c?.type === "thinking") return c.thinking.trim().length;
		return 0;
	}

	/**
	 * Reconcile the reveal cursor with the latest streamed message. Smoothing is
	 * active only for a live, growing stream (no stopReason) when a ticker is
	 * available; once the message settles (stopReason set) everything is revealed
	 * at once, so the final text never lags behind completion.
	 */
	private syncReveal(message: AssistantMessage): void {
		if (!this.smoothing || isReducedMotion() || !this.ui || message.stopReason) {
			this.stopReveal();
			return;
		}
		const idx = this.lastVisibleBlockIndex(message);
		if (idx === -1) {
			this.stopReveal();
			return;
		}
		if (!this.streamVisible) {
			this.revealIndex = idx;
			if (this.revealedChars === Number.POSITIVE_INFINITY) this.revealedChars = 0;
			this.pauseReveal();
			return;
		}
		const newRevealBlock = idx !== this.revealIndex;
		if (idx !== this.revealIndex) {
			// A new trailing block started: reveal it from scratch. Earlier blocks
			// render unclamped (clampReveal only touches revealIndex).
			this.revealIndex = idx;
			this.revealedChars = 0;
			this.lastRevealTarget = 0;
			this.lastRevealTickAt = 0;
		}
		const target = this.blockTextLength(message, idx);
		const burst = Math.max(0, target - this.lastRevealTarget);
		// Incremental small deltas (typical token cadence) pass through immediately;
		// the first paint of a block and large bursts still ease in over a few frames.
		if (burst > 0 && burst <= REVEAL_SNAP_THROUGH_CHARS && !newRevealBlock) {
			this.revealedChars = Math.max(this.revealedChars, target);
		}
		const caughtUpBeforeThisDelta = !newRevealBlock && this.revealedChars >= this.lastRevealTarget;
		if ((newRevealBlock || caughtUpBeforeThisDelta) && this.revealedChars < target) {
			this.revealedChars = Math.min(
				target,
				this.revealedChars + this.computeRevealStep(target - this.revealedChars, 1),
			);
		}
		this.lastRevealTarget = target;
		if (this.revealedChars < target && !this.revealUnsub) {
			this.lastRevealTickAt = 0;
			this.revealUnsub = this.ui.addAnimationCallback((now) => this.revealTick(now));
		}
	}

	private computeRevealStep(backlog: number, frameCount: number): number {
		const perFrame = Math.min(REVEAL_MAX_STEP, Math.max(REVEAL_MIN_STEP, Math.ceil(backlog / REVEAL_CATCHUP_FRAMES)));
		return Math.min(backlog, perFrame * frameCount);
	}

	private revealFrameCount(now: number): number {
		if (this.lastRevealTickAt <= 0) {
			this.lastRevealTickAt = now;
			return 1;
		}
		const elapsedMs = now - this.lastRevealTickAt;
		this.lastRevealTickAt = now;
		if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 1;
		return Math.max(1, Math.min(60, Math.round(elapsedMs / REVEAL_FRAME_MS)));
	}

	/** Advance the reveal cursor one frame; unsubscribe once it catches up. */
	private revealTick(now: number): boolean {
		const message = this.lastMessage;
		if (!message || this.revealIndex === -1) {
			this.stopReveal();
			return false;
		}
		const target = this.blockTextLength(message, this.revealIndex);
		if (this.revealedChars >= target) {
			this.pauseReveal();
			return false; // already caught up — nothing changed this frame
		}
		const backlog = target - this.revealedChars;
		// Geometric catch-up (backlog/FRAMES) already eases out — the step shrinks as
		// the cursor nears the tail. MAX caps the other end so a big burst eases in
		// over a few frames instead of snapping; MIN keeps a slow drip moving.
		const step = this.computeRevealStep(backlog, this.revealFrameCount(now));
		this.revealedChars = Math.min(target, this.revealedChars + step);
		if (!this.updateRevealTrailingBlock()) {
			this.rebuildContent();
		}
		if (this.revealedChars >= target) {
			this.pauseReveal();
		}
		return true;
	}

	/** Update only the trailing reveal block without clearing the content tree. */
	private updateRevealTrailingBlock(): boolean {
		const message = this.lastMessage;
		if (!message || this.revealIndex < 0) return false;

		const content = message.content[this.revealIndex];
		if (!content) return false;

		const entry = this.blockComponents[this.revealIndex];
		if (!entry) return false;

		let raw = "";
		if (content.type === "text") {
			raw = content.text.trim();
		} else if (content.type === "thinking") {
			raw = content.thinking.trim();
		} else {
			return false;
		}

		const text = this.clampReveal(this.revealIndex, raw);
		entry.markdown.setText(text);
		this.contentContainer.markChildStale(entry.component);
		this.decorateSource = null;
		this.decorated = null;
		return true;
	}

	private pauseReveal(): void {
		this.lastRevealTickAt = 0;
		if (this.revealUnsub) {
			this.revealUnsub();
			this.revealUnsub = null;
		}
	}

	/** Stop smoothing and reveal everything (idempotent). */
	private stopReveal(): void {
		this.revealIndex = -1;
		this.revealedChars = Number.POSITIVE_INFINITY;
		this.lastRevealTarget = 0;
		this.lastRevealTickAt = 0;
		this.pauseReveal();
	}

	/** A deliverable is the final TEXT block; thinking-only / empty messages are
	 * never marked. */
	private hasVisibleTextBlock(): boolean {
		return (this.lastMessage?.content ?? []).some(
			(c) => c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0,
		);
	}

	/** Mark this message as the turn's final deliverable: an accent ● is drawn
	 * before its first text line, brightening from full-bright and settling to the
	 * accent color. Static (no ease) in history instances without a ui. Idempotent. */
	markAsDeliverable(): void {
		if (this.isDeliverable) return;
		this.isDeliverable = true;
		if (this.ui) {
			this.deliverableEase ??= new ColorEase(this.ui, () => this.ui?.requestRender());
			this.deliverableEase.begin("text", "accent");
		}
		this.ui?.requestRender();
	}

	/** Mark this message as intermediate step narration: its prose renders dim so
	 * the marked deliverable stands out. No-op on the deliverable itself. */
	markAsNarration(): void {
		if (this.isNarration || this.isDeliverable) return;
		this.isNarration = true;
		this.rebuildContent();
		this.ui?.requestRender();
	}

	private makeProseMarkdown(text: string): Markdown {
		return this.isNarration
			? new Markdown(text, 1, 0, this.markdownTheme, { color: (t: string) => theme.fg("muted", t) })
			: new Markdown(text, 1, 0, this.markdownTheme);
	}

	/** Drive the hidden "Thinking…" label's dim⇄normal oscillation. No-op if
	 * already running (keeps the phase stable across content rebuilds) or no ui. */
	private startThinkingBreath(): void {
		if (this.breathUnsub || !this.ui) return;
		if (isReducedMotion()) {
			this.breathT = 1; // static, fully-lit label; no oscillation
			return;
		}
		this.breathStart = performance.now();
		this.breathBucket = -1;
		this.breathUnsub = this.ui.addAnimationCallback((now: number): boolean => {
			const phase = ((now - this.breathStart) % THINKING_BREATH_MS) / THINKING_BREATH_MS;
			this.breathT = (1 - Math.cos(phase * 2 * Math.PI)) / 2; // smooth 0→1→0
			const bucket = Math.floor(this.breathT * THINKING_BREATH_BUCKETS);
			if (bucket === this.breathBucket) {
				return false;
			}
			this.breathBucket = bucket;
			return true;
		});
	}

	private stopThinkingBreath(): void {
		if (this.breathUnsub) {
			this.breathUnsub();
			this.breathUnsub = null;
		}
	}

	/** Release every animation-ticker subscription this component holds so it is
	 * not retained on the shared animation loop after a history rebuild /
	 * compaction clear. _disposeChatComponents invokes this on each chat child
	 * before tearing the chat down; without it the breath ("Thinking…"),
	 * reveal-cursor, and deliverable-glyph tickers of an in-flight turn would stay
	 * registered forever (CPU each frame + closure retention), exactly the leak the
	 * sibling animated components (Armin/Daxnuts/FusionLive/NavGroup/ActivityLine)
	 * implement dispose() to avoid. Idempotent: each stop is a no-op when inactive. */
	dispose(): void {
		this.stopThinkingBreath();
		this.stopReveal();
		this.deliverableEase?.stop();
	}

	/**
	 * Mark this settled message so its Markdown blocks release their streaming/lex
	 * caches (per-token line cache, table cell caches, incremental lex baseline)
	 * once the final render has run, keeping only the immutable final render cache.
	 * Over a long session those per-message caches pin roughly 3-4× the transcript
	 * text; a settled message only ever re-renders as a pure cache hit (or a one-off
	 * full re-lex on resize), so the streaming caches are dead weight. Deferred to
	 * render() via freezeRequested — see maybeFreezeMarkdown. Idempotent. */
	freeze(): void {
		this.freezeRequested = true;
	}

	/** Drop each Markdown block's streaming caches once a freeze was requested and
	 * the component is fully settled (stopReason set, no live reveal/glyph ease).
	 * Called at the end of super.render(), when every child Markdown's final line
	 * cache is already populated for the current (text, width), so freeze() keeps
	 * that render cache intact and the next render is a pure hit. Markdown.freeze()
	 * is a cheap no-op once already frozen, so re-running each settled frame (and
	 * re-freezing a narration-swapped instance) is safe. */
	private maybeFreezeMarkdown(): void {
		if (!this.freezeRequested) return;
		if (!this.lastMessage?.stopReason) return;
		if (!this.decorationIsStatic()) return;
		for (const entry of this.blockComponents) {
			entry?.markdown.freeze();
		}
	}
}

/** True when the message has content that should appear as its own block:
 * non-empty text always, and non-empty thinking only when thinking is shown
 * (hideThinkingBlock off). A thinking-only message under hidden-thinking returns
 * false, so the activity stacker can suppress it and keep folding tool calls. */
export function messageHasVisibleContent(message: AssistantMessage, includeThinking: boolean): boolean {
	// Error/aborted turns often carry only errorMessage (empty text content).
	// Grouped tool-activity mode defers attach until visible content exists;
	// without this guard those turns never reach the transcript.
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		return true;
	}
	return message.content.some((c) => {
		if (c.type === "text") return typeof c.text === "string" && c.text.trim().length > 0;
		if (includeThinking && c.type === "thinking") {
			return typeof c.thinking === "string" && c.thinking.trim().length > 0;
		}
		return false;
	});
}
