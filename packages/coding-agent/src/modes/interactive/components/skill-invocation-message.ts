import { Markdown, type MarkdownTheme, Text } from "@pit/tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";
import { MessageShell } from "./message-shell.ts";
import { systemMessageLabel } from "./system-message-glyphs.ts";

/**
 * Skill invocation with collapsed / expanded state.
 *
 * Layout (Leva 2): same `MessageShell` chrome as compaction/branch summaries —
 * purple (`gutterCustom`) gutter + glyph + `skill` label. The previous solid
 * `customMessageBg` Box is gone so skills don't look like a different product.
 */
export class SkillInvocationMessageComponent extends MessageShell {
	private expanded = false;
	private skillBlock: ParsedSkillBlock;
	private markdownTheme: MarkdownTheme;

	constructor(skillBlock: ParsedSkillBlock, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super({
			gutterColor: (text: string) => theme.fg("gutterCustom", text),
			label: systemMessageLabel("skill"),
		});
		this.skillBlock = skillBlock;
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
			const header = `**${this.skillBlock.name}**\n\n`;
			this.addChild(new Markdown(header + this.skillBlock.content, 0, 0, this.markdownTheme));
		} else {
			this.addChild(
				new Text(`${this.skillBlock.name} ${theme.fg("dim", `(${keyText("app.tools.expand")} to expand)`)}`, 0, 0),
			);
		}
	}
}
