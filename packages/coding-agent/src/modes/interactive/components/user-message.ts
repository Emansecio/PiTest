import { Markdown, type MarkdownTheme } from "@pit/tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { MessageShell } from "./message-shell.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message.
 *
 * Layout: the unified `MessageShell` with a blue (`gutterUser`) gutter and
 * no label — the role is unambiguous from the color alone. No background
 * fill (D1=B), no internal padding: the shell's 1-col gutter is the sole
 * decoration.
 *
 * OSC 133 zone markers wrap the rendered output so terminal integrations
 * (iTerm, WezTerm, Windows Terminal, etc.) treat the block as an input
 * zone — required for "jump between prompts" navigation. They sit on the
 * first and last rendered lines of the shell-decorated output, including
 * the leading blank that the shell emits.
 */
export class UserMessageComponent extends MessageShell {
	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super({
			gutterColor: (content: string) => theme.fg("gutterUser", content),
		});
		this.addChild(
			new Markdown(text, 0, 0, markdownTheme, {
				color: (content: string) => theme.fg("userMessageText", content),
			}),
		);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
