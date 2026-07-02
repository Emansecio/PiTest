import type { AgentMessage } from "./types.ts";

export const TTSR_STEER_TEXT_MARKER = "<system-reminder>[TTSR:";

const TTSR_RULE_NAME_REGEX = /<system-reminder>\[TTSR:([^\]]+)\]/;

function getUserMessageText(message: AgentMessage): string {
	if (message.role !== "user") {
		return "";
	}
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** True for live (_ttsr_injected) or JSONL-restored TTSR steer messages. */
export function isTtsrSteerMessage(message: AgentMessage): boolean {
	if (message.role !== "user") {
		return false;
	}
	const tagged = message as { _ttsr_injected?: boolean };
	if (tagged._ttsr_injected === true) {
		return true;
	}
	return getUserMessageText(message).includes(TTSR_STEER_TEXT_MARKER);
}

/** One-line TUI/export summary; the full system-reminder text stays in LLM context. */
export function formatTtsrSteerDisplayLine(message: AgentMessage): string {
	const tagged = message as { _ttsr_rule?: string };
	if (tagged._ttsr_rule) {
		return `Rule "${tagged._ttsr_rule}" matched. Model notified.`;
	}
	const text = getUserMessageText(message);
	const match = text.match(TTSR_RULE_NAME_REGEX);
	if (match) {
		return `Rule "${match[1]}" matched. Model notified.`;
	}
	return "Stream rule matched. Model notified.";
}
