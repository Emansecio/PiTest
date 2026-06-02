import type { AssistantMessage } from "@pit/ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@pit/tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { ReadingColumn } from "./reading-column.ts";

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

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;

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

		// Clear content container
		this.contentContainer.clear();

		// Index of the last visible (non-empty text/thinking) block. Computed once
		// here so the per-block "is there a visible block after me?" check below is
		// an O(1) index compare instead of an O(n) slice().some() per iteration
		// (which made updateContent O(n²) in block count on every stream delta).
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
				const text = content.text.trim();
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
					const thinking = content.thinking.trim();
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
}
