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

	async send(args: SendArgs): Promise<SendResult> {
		const { from, to, message } = args;
		const timeoutMs = args.timeoutMs ?? DEFAULT_MESSAGE_TIMEOUT_MS;
		const result: SendResult = { from, to, delivered: [], replies: [], failed: [], notFound: [] };

		const targets: AgentParticipant[] = [];
		if (to === "all") {
			for (const p of this.list()) {
				if (p.id !== from && p.status === "running") targets.push(p);
			}
		} else {
			const t = this.#participants.get(to);
			if (!t || t.id === from || t.status !== "running") {
				result.notFound.push(to);
			} else {
				targets.push(t);
			}
		}

		await Promise.all(
			targets.map(async (target) => {
				if (!target.respond) {
					result.failed.push({ id: target.id, error: "not reachable (no responder attached)" });
					return;
				}
				target.lastActivity = this.#now();
				try {
					const text = await this.#dispatch(target.respond, from, message, timeoutMs, args.signal);
					result.delivered.push(target.id);
					result.replies.push({ from: target.id, text });
				} catch (err) {
					result.failed.push({ id: target.id, error: err instanceof Error ? err.message : String(err) });
				}
			}),
		);
		return result;
	}

	// Race the responder against a timeout/parent-abort. Owns its own controller
	// so a slow recipient cannot stall the caller or its sibling dispatches.
	async #dispatch(
		respond: AgentResponder,
		from: string,
		message: string,
		timeoutMs: number,
		parentSignal: AbortSignal | undefined,
	): Promise<string> {
		const controller = new AbortController();
		const onParentAbort = () => controller.abort();
		if (parentSignal) {
			if (parentSignal.aborted) controller.abort();
			else parentSignal.addEventListener("abort", onParentAbort, { once: true });
		}
		const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
		const timedOut = new Promise<never>((_resolve, reject) => {
			if (controller.signal.aborted) {
				reject(new Error("message dispatch aborted"));
				return;
			}
			controller.signal.addEventListener("abort", () => reject(new Error("message dispatch aborted")), {
				once: true,
			});
		});
		try {
			return await Promise.race([respond(from, message, controller.signal), timedOut]);
		} finally {
			if (timer) clearTimeout(timer);
			if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
		}
	}
}

/** Process-global singleton. One bus per Node process. */
export const agentMessageBus = new AgentMessageBus();
