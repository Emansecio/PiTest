/**
 * Shared transcript invariant: every `toolCall` id that appears in an assistant
 * message must have a corresponding `toolResult` message. An assistant `tool_use`
 * with no paired `tool_result` is an orphan — the next provider request rejects it
 * (Anthropic returns a 400 for an unresolved tool_use).
 */

import type { AgentMessage } from "@pit/agent-core";
import { expect } from "vitest";

/** Return the `name#id` of every assistant toolCall lacking a matching toolResult. */
export function collectOrphanToolCalls(messages: AgentMessage[]): string[] {
	const resultIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") resultIds.add(message.toolCallId);
	}
	const orphans: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "toolCall" && !resultIds.has(part.id)) {
				orphans.push(`${part.name}#${part.id}`);
			}
		}
	}
	return orphans;
}

/** Assert the transcript has no orphaned tool calls. */
export function assertNoOrphanToolCalls(messages: AgentMessage[]): void {
	expect(collectOrphanToolCalls(messages)).toEqual([]);
}
