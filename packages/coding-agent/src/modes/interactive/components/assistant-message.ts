import type { AssistantMessage } from "@pit/ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text, type TUI } from "@pit/tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { ReadingColumn } from "./reading-column.ts";

// Streaming smoothing (opt-in): instead of painting each provider burst whole,
// the trailing block's text is revealed at a steady rate off the shared
// animation ticker. The cursor catches up to the streamed backlog in
// ~REVEAL_CATCHUP_FRAMES frames so it never lags far behind on long bursts,
// while a slow drip still advances at least REVEAL_MIN_STEP chars/frame.
const REVEAL_CATCHUP_FRAMES = 8; // ~130ms to absorb a burst at 60fps
const REVEAL_MIN_STEP = 1;

/**
 * Max width (in columns) for assistant prose. On wide terminals the body text
 * is capped to this so lines stay a comfortable reading length instead of
 * running edge to edge; the gutter and full-width rules are unaffected. Only
 * assistant text/thinking is capped — tool output, bash, and code blocks keep
 * full width. Tune here (a settings-backed value is a possible follow-up).
 */
const ASSISTANT_READING_COLUMNS = 100;

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

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
	component: ReadingColumn;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
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
	private revealIndex = -1;
	private revealedChars = Number.POSITIVE_INFINITY;
	private revealUnsub: (() => void) | null = null;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		ui?: TUI,
		smoothing = false,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.ui = ui;
		this.smoothing = smoothing;

		// Container for text/thinking content
		this.contentContainer = new Container();
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

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;
		this.syncReveal(message);
		this.rebuildContent();
	}

	/**
	 * Rebuild the content container from `this.lastMessage`, honoring the reveal
	 * cursor when streaming smoothing is active (the trailing block is clamped to
	 * `revealedChars`). Pure with respect to the animation ticker — it never
	 * subscribes or unsubscribes, so the ticker can call it every frame safely.
	 */
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
				if (entry?.kind === "text") {
					entry.markdown.setText(text);
				} else {
					const markdown = new Markdown(text, 1, 0, this.markdownTheme);
					entry = {
						kind: "text",
						markdown,
						component: new ReadingColumn(markdown, ASSISTANT_READING_COLUMNS),
					};
					this.blockComponents[i] = entry;
				}
				this.contentContainer.addChild(entry.component);
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = i < lastVisibleIndex;

				if (this.hideThinkingBlock) {
					// Show static thinking label when hidden. Drop any cached Markdown at
					// this slot so a later un-hide rebuilds it fresh.
					this.blockComponents[i] = undefined;
					this.contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), 1, 0),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else {
					// Thinking traces in thinkingText color, italic
					const thinking = this.clampReveal(i, content.thinking.trim());
					let entry = this.blockComponents[i];
					if (entry?.kind === "thinking") {
						entry.markdown.setText(thinking);
					} else {
						const markdown = new Markdown(thinking, 1, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						});
						entry = {
							kind: "thinking",
							markdown,
							component: new ReadingColumn(markdown, ASSISTANT_READING_COLUMNS),
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
	}

	/** Clamp a block's text to the reveal cursor when it is the block currently
	 * being smoothed; otherwise return it whole. */
	private clampReveal(index: number, text: string): string {
		if (this.revealIndex !== index || this.revealedChars >= text.length) return text;
		return text.slice(0, this.revealedChars);
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
		if (!this.smoothing || !this.ui || message.stopReason) {
			this.stopReveal();
			return;
		}
		const idx = this.lastVisibleBlockIndex(message);
		if (idx === -1) {
			this.stopReveal();
			return;
		}
		if (idx !== this.revealIndex) {
			// A new trailing block started: reveal it from scratch. Earlier blocks
			// render unclamped (clampReveal only touches revealIndex).
			this.revealIndex = idx;
			this.revealedChars = 0;
		}
		const target = this.blockTextLength(message, idx);
		if (this.revealedChars < target && !this.revealUnsub) {
			this.revealUnsub = this.ui.addAnimationCallback((now) => this.revealTick(now));
		}
	}

	/** Advance the reveal cursor one frame; unsubscribe once it catches up. */
	private revealTick(_now: number): boolean {
		const message = this.lastMessage;
		if (!message || this.revealIndex === -1) {
			this.stopReveal();
			return false;
		}
		const target = this.blockTextLength(message, this.revealIndex);
		if (this.revealedChars >= target) {
			this.stopReveal();
			return false; // already caught up — nothing changed this frame
		}
		const backlog = target - this.revealedChars;
		const step = Math.max(REVEAL_MIN_STEP, Math.ceil(backlog / REVEAL_CATCHUP_FRAMES));
		this.revealedChars = Math.min(target, this.revealedChars + step);
		this.rebuildContent();
		return true;
	}

	/** Stop smoothing and reveal everything (idempotent). */
	private stopReveal(): void {
		this.revealIndex = -1;
		this.revealedChars = Number.POSITIVE_INFINITY;
		if (this.revealUnsub) {
			this.revealUnsub();
			this.revealUnsub = null;
		}
	}
}
