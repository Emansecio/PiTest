import { Markdown, type MarkdownTheme, Text } from "@pit/tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";
import { MessageShell } from "./message-shell.ts";
import { systemMessageLabel } from "./system-message-glyphs.ts";

/**
 * Component that renders a compaction marker with collapsed / expanded state.
 *
 * Layout (Leva 2): unified `MessageShell` with a glyph + `compaction` label
 * carried by the shell and a purple (`gutterCustom`) gutter. The previous
 * `Box(1,1, customMsgBg)` background is gone — gutter only.
 */
export class CompactionSummaryMessageComponent extends MessageShell {
	private expanded = false;
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: CompactionSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super({
			gutterColor: (text: string) => theme.fg("gutterCustom", text),
			label: systemMessageLabel("compaction"),
		});
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		const tokenStr = this.message.tokensBefore.toLocaleString();

		if (this.expanded) {
			// Expanded: bold "Compacted from N tokens" headline + the model's
			// summary as markdown. Default fg (no per-block tint) so the
			// summary reads like body text rather than competing with the
			// shell color.
			const header = `**Compacted from ${tokenStr} tokens**\n\n`;
			this.addChild(new Markdown(header + this.message.summary, 0, 0, this.markdownTheme));
		} else {
			// Collapsed: single line summary + dim expand-hint.
			this.addChild(
				new Text(
					`Compacted from ${tokenStr} tokens ${theme.fg("dim", `(${keyText("app.tools.expand")} to expand)`)}`,
					0,
					0,
				),
			);
		}
	}
}
