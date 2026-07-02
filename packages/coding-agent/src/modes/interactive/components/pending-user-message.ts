import { TruncatedText } from "@pit/tui";
import { theme } from "../theme/theme.ts";
import { MessageShell } from "./message-shell.ts";

export type PendingDeliveryMode = "steer" | "queued";

/** Ephemeral pending user message shown above the editor while the agent runs. */
export class PendingUserMessageComponent extends MessageShell {
	constructor(mode: PendingDeliveryMode, text: string) {
		const label = mode === "steer" ? "[steer]" : "[queued]";
		const gutterColor =
			mode === "steer"
				? (content: string) => theme.fg("gutterUser", content)
				: (content: string) => theme.fg("muted", content);
		super({
			gutterColor,
			label,
			noLeadingGap: true,
		});
		const singleLine = text.replace(/\s+/g, " ").trim();
		this.addChild(new TruncatedText(theme.fg("dim", singleLine), 0, 0));
	}
}
