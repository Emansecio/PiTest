import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { agentMessageBus } from "../messaging/index.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export interface MessageToolOptions {
	/** This agent's own bus id — the `from` of every send. */
	selfId: string;
	/** Per-dispatch reply timeout in ms. Defaults to the bus default (120s). */
	timeoutMs?: number;
}

const messageSchema = Type.Object({
	op: Type.Union([Type.Literal("send"), Type.Literal("list")], {
		description: 'Operation: "send" a message to a peer, or "list" the agents currently online.',
	}),
	to: Type.Optional(
		Type.String({ description: 'Recipient agent id, or "all" to broadcast. Required for op:"send".' }),
	),
	message: Type.Optional(Type.String({ description: 'Message body (plain prose). Required for op:"send".' })),
});

type MessageParams = Static<typeof messageSchema>;

export interface MessageDetails {
	op: "send" | "list";
	from: string;
	to?: string;
	delivered?: string[];
	replies?: Array<{ from: string; text: string }>;
	failed?: Array<{ id: string; error: string }>;
	notFound?: string[];
	peers?: Array<{ id: string; kind: string; status: string }>;
}

const DESCRIPTION =
	"Coordinate with other agents running in parallel. " +
	'op:"list" shows who is online. op:"send" delivers `message` to `to` (an agent id, or "all" to broadcast) ' +
	"and returns their reply synchronously — use it to ask a question you are blocked on instead of guessing " +
	"(e.g. confirm a path, deconflict a file). The reply is computed from the peer's current context; it does " +
	"not interrupt their work. Keep messages short and prose-only.";

export function createMessageToolDefinition(
	_cwd: string,
	options: MessageToolOptions,
): ToolDefinition<typeof messageSchema, MessageDetails> {
	const selfId = options.selfId;
	return {
		name: "message",
		label: "message",
		description: DESCRIPTION,
		promptSnippet: "Message a peer agent and get a synchronous reply, or list online peers.",
		parameters: messageSchema,
		activity: "navigation",
		executionMode: "sequential",
		async execute(_toolCallId, params: MessageParams, signal) {
			if (params.op === "list") {
				const peers = agentMessageBus.listVisibleTo(selfId);
				const details: MessageDetails = {
					op: "list",
					from: selfId,
					peers: peers.map((p) => ({ id: p.id, kind: p.kind, status: p.status })),
				};
				const body =
					peers.length === 0
						? "No other agents are currently online."
						: `Online peers:\n${peers.map((p) => `- ${p.id} (${p.kind})`).join("\n")}`;
				return { content: [{ type: "text" as const, text: body }], details };
			}

			const to = params.to?.trim();
			const message = params.message?.trim();
			if (!to) throw new Error('message send requires "to" (an agent id or "all").');
			if (!message) throw new Error('message send requires a non-empty "message".');

			const sent = await agentMessageBus.send({
				from: selfId,
				to,
				message,
				signal,
				timeoutMs: options.timeoutMs,
			});
			const details: MessageDetails = {
				op: "send",
				from: selfId,
				to,
				delivered: sent.delivered,
				replies: sent.replies,
				failed: sent.failed,
				notFound: sent.notFound,
			};
			const lines: string[] = [];
			for (const r of sent.replies) lines.push(`${r.from} replied: ${r.text}`);
			if (sent.notFound.length > 0) lines.push(`Not found / offline: ${sent.notFound.join(", ")}`);
			if (sent.failed.length > 0) {
				lines.push(`Failed: ${sent.failed.map((f) => `${f.id} (${f.error})`).join(", ")}`);
			}
			if (lines.length === 0) {
				lines.push(`Delivered to ${sent.delivered.join(", ") || "(no recipients)"}.`);
			}
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details };
		},
	};
}

/** AgentTool form, for injection into a subagent's tool catalog. */
export function createMessageTool(cwd: string, options: MessageToolOptions) {
	return wrapToolDefinition(createMessageToolDefinition(cwd, options));
}
