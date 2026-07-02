import type { AgentMessage } from "@pit/agent-core";
import { formatTtsrSteerDisplayLine } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { theme } from "../theme/theme.ts";
import { MessageShell } from "./message-shell.ts";

/**
 * Compact one-line transcript entry for a TTSR steer.
 * The full `<system-reminder>` text remains in LLM context only.
 */
export class TtsrSteerMessageComponent extends MessageShell {
	constructor(message: AgentMessage) {
		super({
			gutterColor: (text: string) => theme.fg("warning", text),
			label: "[ttsr]",
		});
		this.addChild(new Text(formatTtsrSteerDisplayLine(message), 0, 0));
	}
}
