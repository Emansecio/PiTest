import type {
	AgentParticipant,
	AgentResponder,
	ParticipantStatus,
	PeerInfo,
	ReserveOptions,
	SendArgs,
	SendResult,
} from "./types.ts";

/** Default per-dispatch reply timeout (matches omp's `irc.timeoutMs`). */
export const DEFAULT_MESSAGE_TIMEOUT_MS = 120_000;

function toPeerInfo(p: AgentParticipant): PeerInfo {
	return { id: p.id, displayName: p.displayName, kind: p.kind, parentId: p.parentId, status: p.status };
}

/**
 * Process-global registry + router for inter-agent messages.
 *
 * In-memory, single process: "routing" is a direct call to another live
 * participant's `respond` closure. No queue, no broker. Modeled on
 * `dapSessionManager`.
 */
export class AgentMessageBus {
	#participants = new Map<string, AgentParticipant>();
	#now: () => number;

	// `now` is injectable so tests can pin timestamps (Date.now is fine in prod).
	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** Reserve a unique id and register a placeholder (respond = null). */
	reserve(base: string, options: ReserveOptions): string {
		const id = this.#allocateId(base);
		const ts = this.#now();
		this.#participants.set(id, {
			id,
			displayName: options.displayName ?? id,
			kind: options.kind,
			parentId: options.parentId,
			status: "running",
			respond: null,
			createdAt: ts,
			lastActivity: ts,
		});
		return id;
	}

	#allocateId(base: string): string {
		const clean = base.trim() || "Agent";
		if (!this.#participants.has(clean)) return clean;
		let n = 2;
		while (this.#participants.has(`${clean}-${n}`)) n++;
		return `${clean}-${n}`;
	}

	attachResponder(id: string, respond: AgentResponder): void {
		const p = this.#participants.get(id);
		if (p) {
			p.respond = respond;
			p.lastActivity = this.#now();
		}
	}

	setStatus(id: string, status: ParticipantStatus): void {
		const p = this.#participants.get(id);
		if (p) {
			p.status = status;
			p.lastActivity = this.#now();
		}
	}

	unregister(id: string): void {
		this.#participants.delete(id);
	}

	get(id: string): AgentParticipant | undefined {
		return this.#participants.get(id);
	}

	list(): AgentParticipant[] {
		return [...this.#participants.values()];
	}

	/** Running participants other than `id`, as serializable peer info. */
	listVisibleTo(id: string): PeerInfo[] {
		return this.list()
			.filter((p) => p.id !== id && p.status === "running")
			.map(toPeerInfo);
	}

	// send() is implemented in Task 2.
	async send(_args: SendArgs): Promise<SendResult> {
		throw new Error("not implemented");
	}
}

/** Process-global singleton. One bus per Node process. */
export const agentMessageBus = new AgentMessageBus();
