import { Text } from "@pit/tui";
import { theme } from "../theme/theme.ts";
import { formatTurnDoneDisplayLine, type TurnDoneSnapshot } from "../turn-done-format.ts";
import { MessageShell } from "./message-shell.ts";

/** Compact one-line transcript entry when a user turn completes. Ephemeral (not persisted). */
export class TurnDoneMessageComponent extends MessageShell {
	constructor(snapshot: TurnDoneSnapshot) {
		super({
			gutterColor: (text: string) => theme.fg("muted", text),
			label: "[done]",
		});
		this.addChild(new Text(formatTurnDoneDisplayLine(snapshot), 0, 0));
	}
}
