/**
 * Inter-agent messaging vocabulary.
 *
 * A "participant" is any agent reachable on the bus: the parent session
 * (`kind: "main"`) or a running subagent (`kind: "sub"`). Each participant
 * exposes a `respond` closure that produces a prose reply to an incoming
 * message; see `makeAgentResponder`.
 */

export type ParticipantKind = "main" | "sub";

/** Lifecycle state. Only `running` participants are addressable. */
export type ParticipantStatus = "running" | "completed" | "aborted";

/**
 * Computes a reply to an incoming message. Runs on an ephemeral side-channel,
 * never on the recipient's main loop, so it is safe to call while the recipient
 * is mid-tool-call. Must reject (not hang) when `signal` aborts.
 */
export type AgentResponder = (from: string, message: string, signal?: AbortSignal) => Promise<string>;

/**
 * Delivers a fire-and-forget notice into the recipient's run (no reply awaited).
 * Splices the message into the recipient's transcript at its next turn WITHOUT
 * forcing a turn — see `Agent.injectPassive`. Safe to call mid-run.
 */
export type AgentDelivery = (from: string, message: string) => void;

export interface AgentParticipant {
	id: string;
	displayName: string;
	kind: ParticipantKind;
	parentId?: string;
	status: ParticipantStatus;
	/** Null between `reserve` and `attachResponder` (placeholder window). */
	respond: AgentResponder | null;
	/** Fire-and-forget delivery channel; null until attached. */
	deliver: AgentDelivery | null;
	createdAt: number;
	lastActivity: number;
}

export interface ReserveOptions {
	kind: ParticipantKind;
	displayName?: string;
	parentId?: string;
}

/** Public, serializable view of a participant (no live closure). */
export interface PeerInfo {
	id: string;
	displayName: string;
	kind: ParticipantKind;
	parentId?: string;
	status: ParticipantStatus;
}

export interface SendReply {
	from: string;
	text: string;
}

export interface SendFailure {
	id: string;
	error: string;
}

export interface SendResult {
	from: string;
	to: string;
	delivered: string[];
	replies: SendReply[];
	failed: SendFailure[];
	notFound: string[];
}

/**
 * customType for the display-only inter-agent relay line shown in the parent's
 * transcript. It is dropped from the LLM context (see `convertToLlm`), so it is
 * never visible to the model — purely an observability surface for the user.
 */
export const MESSAGE_RELAY_CUSTOM_TYPE = "pi.message-relay";

/** One recorded inter-agent send, for observability (`/messages` + live relay). */
export interface MessageActivity {
	from: string;
	to: string;
	/** Message body, clipped for the log/relay. */
	message: string;
	/** "reply" = request/reply round-trip; "notify" = fire-and-forget. */
	mode: "reply" | "notify";
	delivered: string[];
	replies: number;
	failed: number;
	notFound: number;
	at: number;
}

export interface SendArgs {
	from: string;
	/** A participant id, or "all" to broadcast to every running peer. */
	to: string;
	message: string;
	signal?: AbortSignal;
	/** Per-dispatch reply timeout in ms. 0 disables. Defaults to the bus default. */
	timeoutMs?: number;
	/**
	 * When true (default), blocks for the recipient's reply. When false, delivers
	 * the message fire-and-forget via the recipient's `deliver` channel and
	 * returns immediately with no reply.
	 */
	awaitReply?: boolean;
}
