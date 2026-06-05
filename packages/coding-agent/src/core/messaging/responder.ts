import type { Agent, AgentMessage } from "@pit/agent-core";
import type { AssistantMessage, Context } from "@pit/ai";
import type { AgentDelivery, AgentResponder } from "./types.ts";

/** One completed side-channel exchange, kept so a thread stays coherent. */
interface IrcExchange {
	from: string;
	message: string;
	reply: string;
}

/** How many prior exchanges to carry as side-channel memory (oldest dropped). */
const MAX_THREAD = 12;
/** Per-line clip so a long message can't bloat the side-channel context. */
const CLIP = 400;

function clip(text: string, max = CLIP): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Renders prior exchanges as a compact recap the recipient can read back. */
function renderThread(thread: readonly IrcExchange[]): string {
	if (thread.length === 0) return "";
	const lines = thread.map((e) => `- \`${e.from}\` asked: "${clip(e.message)}" — you replied: "${clip(e.reply)}"`);
	return (
		"Earlier in this side-channel thread (coordination with other agents — not part of your task):\n" +
		`${lines.join("\n")}\n\n`
	);
}

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
 *
 * The responder is stateful across calls: it remembers prior exchanges in a
 * closure-local, capped thread and replays them into each side-channel turn, so
 * a multi-message conversation with a peer stays coherent. This memory lives
 * ONLY in the side-channel — it never enters the recipient's task transcript or
 * affects the value the agent ultimately returns to its parent.
 */
export function makeAgentResponder(agent: Agent): AgentResponder {
	const thread: IrcExchange[] = [];
	return async (from, message, signal) => {
		const snapshot = agent.state.messages.slice();
		const incoming: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: renderThread(thread) + renderIncomingMessage(from, message) }],
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
		const reply = extractReplyText(result.content);
		thread.push({ from, message, reply });
		if (thread.length > MAX_THREAD) thread.shift();
		return reply;
	};
}

/** Frames a fire-and-forget notice for passive injection (no reply expected). */
export function renderPassiveNotice(from: string, message: string): string {
	return (
		`[message from \`${from}\`]\n\n${message}\n\n` +
		"(Another agent sent you this while you work in parallel. Take it into account if relevant; " +
		"you don't need to reply or change course unless it matters to your task.)"
	);
}

/**
 * Builds an {@link AgentDelivery} backed by a live `Agent`.
 *
 * Splices a fire-and-forget notice into the agent's run via `injectPassive`, so
 * the recipient sees it on a turn it was already going to take — never forcing
 * an extra turn or altering the value the agent ultimately returns.
 */
export function makeAgentDelivery(agent: Agent): AgentDelivery {
	return (from, message) => {
		agent.injectPassive({
			role: "user",
			content: [{ type: "text", text: renderPassiveNotice(from, message) }],
			timestamp: Date.now(),
		});
	};
}
