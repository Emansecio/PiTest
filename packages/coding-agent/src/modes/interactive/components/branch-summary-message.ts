import { Markdown, type MarkdownTheme, Text } from "@pit/tui";
import type { BranchSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";
import { MessageShell } from "./message-shell.ts";
import { systemMessageLabel } from "./system-message-glyphs.ts";

/**
 * Component that renders a branch summary with collapsed / expanded state.
 *
 * Layout (Leva 2): unified `MessageShell` with a glyph + `branch` label and a
 * purple (`gutterCustom`) gutter — same chrome as compaction summaries so the
 * two related "summary" idioms stay visually consistent.
 */
export class BranchSummaryMessageComponent extends MessageShell {
	private expanded = false;
	private message: BranchSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: BranchSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super({
			gutterColor: (text: string) => theme.fg("gutterCustom", text),
			label: systemMessageLabel("branch"),
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

		if (this.expanded) {
			const header = "**Branch Summary**\n\n";
			this.addChild(new Markdown(header + this.message.summary, 0, 0, this.markdownTheme));
		} else {
			this.addChild(
				new Text(`Branch summary ${theme.fg("dim", `(${keyText("app.tools.expand")} to expand)`)}`, 0, 0),
			);
		}
	}
}
