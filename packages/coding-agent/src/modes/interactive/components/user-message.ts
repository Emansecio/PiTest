import { Markdown, type MarkdownTheme } from "@pit/tui";
import { DEFAULT_ASSISTANT_READING_COLUMNS } from "../../../core/settings-manager.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { MessageShell } from "./message-shell.ts";
import { ReadingColumn } from "./reading-column.ts";

// FTCS / OSC 133 semantic prompt zone. A user message is the "command" the
// user issued, so it carries the PROMPT zone: A (prompt start) … B (command
// entered). The assistant response carries the OUTPUT zone (C … D) — see
// assistant-message.ts. The old code emitted A/B/C on *both* blocks, which
// told terminals that assistant output was itself a prompt: "jump to previous
// prompt" then landed inside answers, and "select command output" had no
// distinct output zone. Splitting prompt (A/B here) from output (C/D there)
// restores FTCS-faithful navigation.
//
// INVARIANT: the markers ride the FIRST and LAST rendered lines of the block
// and are NOT re-emitted per line (unlike OSC 8 hyperlinks, which reopen on
// each wrapped line). A downstream pass that clips the first or last line in
// isolation would open a zone without closing it — first + last must survive
// together.
const OSC133_PROMPT_START = "\x1b]133;A\x07"; // FTCS A: prompt start (jump target)
const OSC133_PROMPT_END = "\x1b]133;B\x07"; // FTCS B: command entered / end of prompt

/**
 * Component that renders a user message.
 *
 * Layout: the unified `MessageShell` with a blue (`gutterUser`) gutter using
 * the heavier `▌` glyph and no label — weight + color are two redundant
 * signals for "what I asked", since several other block types also carry a
 * thin colored `│`. No background fill (D1=B), no internal padding. The
 * markdown body shares the assistant's reading column so a long prompt and
 * its answer wrap at the same measure on wide terminals.
 *
 * OSC 133 prompt-zone markers (A … B) wrap the rendered output so terminal
 * integrations (iTerm, WezTerm, Ghostty, Windows Terminal, etc.) treat the
 * block as a prompt zone — the jump target for "jump between prompts". They
 * sit on the first and last rendered lines of the shell-decorated output,
 * including the leading blank that the shell emits.
 */
export class UserMessageComponent extends MessageShell {
	// Decorated-output memo keyed by the shell's returned array reference.
	// MessageShell.render is memoized and hands back the same array instance
	// while nothing changed (Component render contract); mutating it in place
	// would accumulate the OSC markers frame over frame, and slicing every
	// frame would defeat the parent Container's flatten cache. Re-decorating
	// only when the shell's array identity changes keeps both.
	private decorateSource: string[] | null = null;
	private decorated: string[] | null = null;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		readingColumns: number = DEFAULT_ASSISTANT_READING_COLUMNS,
	) {
		super({
			gutterColor: (content: string) => theme.fg("gutterUser", content),
			gutterChar: "▌",
		});
		const markdown = new Markdown(text, 0, 0, markdownTheme, {
			color: (content: string) => theme.fg("userMessageText", content),
		});
		this.addChild(new ReadingColumn(markdown, readingColumns > 0 ? readingColumns : 0));
	}

	override render(width: number): string[] {
		const rendered = super.render(width);
		if (rendered.length === 0) {
			return rendered;
		}
		if (rendered === this.decorateSource && this.decorated !== null) {
			return this.decorated;
		}

		// Copy-on-write: never mutate the shell's (memoized) array in place.
		const lines = rendered.slice();
		lines[0] = OSC133_PROMPT_START + lines[0];
		lines[lines.length - 1] = lines[lines.length - 1] + OSC133_PROMPT_END;
		this.decorateSource = rendered;
		this.decorated = lines;
		return lines;
	}
}
