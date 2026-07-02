import type { AgentMessage } from "@pit/agent-core";
import { formatOverthinkSteerDisplayLine } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { theme } from "../theme/theme.ts";
import { MessageShell } from "./message-shell.ts";

/**
 * Compact one-line transcript entry for an overthink-guard steer.
 * The full `<system-reminder>` text remains in LLM context only.
 */
export class OverthinkSteerMessageComponent extends MessageShell {
	constructor(message: AgentMessage) {
		super({
			gutterColor: (text: string) => theme.fg("warning", text),
			label: "[overthink]",
		});
		this.addChild(new Text(formatOverthinkSteerDisplayLine(message), 0, 0));
	}
}
