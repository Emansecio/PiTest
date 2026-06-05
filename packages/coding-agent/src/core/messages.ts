/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@pit/agent-core";
import type { ImageContent, Message, TextContent } from "@pit/ai";
import { MESSAGE_RELAY_CUSTOM_TYPE } from "./messaging/types.ts";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@pit/agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

// Cache LLM conversion per source AgentMessage. The session preserves element
// identity across turns (session-manager.ts buildSessionContext slices but keeps
// the same message objects), so without this the full history is re-mapped every
// turn. For passthrough roles (user/assistant/toolResult) the cache stores `m`
// itself, so in-place mutation by the agent loop stays reflected. For derived
// roles (bashExecution/custom/branchSummary/compactionSummary) the cached Message
// is built once from `m`'s fields — callers that mutate a derived AgentMessage in
// place MUST call invalidateMessageCache(m) to avoid stale conversions.
const convertCache = new WeakMap<AgentMessage, Message>();

export function invalidateMessageCache(m: AgentMessage): void {
	convertCache.delete(m);
}

function convertOne(m: AgentMessage): Message | undefined {
	switch (m.role) {
		case "bashExecution":
			// Skip messages excluded from context (!! prefix)
			if (m.excludeFromContext) {
				return undefined;
			}
			return {
				role: "user",
				content: [{ type: "text", text: bashExecutionToText(m) }],
				timestamp: m.timestamp,
			};
		case "custom": {
			// Inter-agent relay lines are display-only — never shown to the model.
			if (m.customType === MESSAGE_RELAY_CUSTOM_TYPE) return undefined;
			const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
			return {
				role: "user",
				content,
				timestamp: m.timestamp,
			};
		}
		case "branchSummary":
			return {
				role: "user",
				content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
				timestamp: m.timestamp,
			};
		case "compactionSummary":
			return {
				role: "user",
				content: [
					{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
				],
				timestamp: m.timestamp,
			};
		case "user":
		case "assistant":
		case "toolResult":
			return m;
		default:
			// biome-ignore lint/correctness/noSwitchDeclarations: fine
			const _exhaustiveCheck: never = m;
			return undefined;
	}
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	const result: Message[] = [];
	for (const m of messages) {
		const cached = convertCache.get(m);
		if (cached !== undefined) {
			result.push(cached);
			continue;
		}
		const converted = convertOne(m);
		if (converted !== undefined) {
			convertCache.set(m, converted);
			result.push(converted);
		}
	}
	return result;
}
