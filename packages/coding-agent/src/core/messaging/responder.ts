import type { Agent, AgentMessage } from "@pit/agent-core";
import type { AssistantMessage, Context } from "@pit/ai";
import type { AgentResponder } from "./types.ts";

/** Wraps an incoming message in a reply-focused user prompt. */
export function renderIncomingMessage(from: string, message: string): string {
	return (
		`You received a direct message from agent \`${from}\`:\n\n` +
		`${message}\n\n` +
		"Reply briefly and directly using the conversation context you already have. " +
		"Plain prose only — do not call any tools, and do not output JSON or status payloads."
	);
}

function extractReplyText(content: AssistantMessage["content"]): string {
	const text = content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	return text.length > 0 ? text : "(no reply)";
}

/**
 * Builds an {@link AgentResponder} backed by a live `Agent`.
 *
 * The reply is computed on an ephemeral, tool-less completion against a
 * READ-ONLY snapshot of the agent's current messages — it reuses the agent's
 * own `streamFn` (so it inherits auth/retries) but starts a separate provider
 * request that never touches the agent's main run or its persisted history.
 * This is what makes it safe to message an agent that is mid-tool-call.
 */
export function makeAgentResponder(agent: Agent): AgentResponder {
	return async (from, message, signal) => {
		const snapshot = agent.state.messages.slice();
		const incoming: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: renderIncomingMessage(from, message) }],
			timestamp: Date.now(),
		};
		const llmMessages = await agent.convertToLlm([...snapshot, incoming]);
		const context: Context = {
			systemPrompt: agent.state.systemPrompt,
			messages: llmMessages,
			tools: [],
		};
		const stream = await agent.streamFn(agent.state.model, context, { signal });
		const result = await stream.result();
		return extractReplyText(result.content);
	};
}
