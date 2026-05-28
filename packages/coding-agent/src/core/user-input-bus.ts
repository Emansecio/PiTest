/**
 * UserInputBus
 *
 * In-process request/response bus that lets tool `execute()` implementations
 * ask the active mode for a structured option pick mid-turn.
 *
 * Pattern:
 *   - Tool calls `bus.askOptions(req)` and awaits the answer.
 *   - Active mode (interactive) calls `bus.onRequest(...)` once, renders an
 *     overlay/picker, and resolves with `bus.resolve(requestId, answer)`.
 *
 * Print / non-interactive mode does NOT subscribe; in that case `askOptions`
 * auto-resolves with the recommended option (or the first option) so tools
 * remain deterministic without a UI binding.
 */

import { randomUUID } from "node:crypto";

export interface AskOptionsRequest {
	requestId: string;
	question: string;
	header?: string;
	options: Array<{ label: string; description?: string; recommended?: boolean; value?: string }>;
	multiSelect?: boolean;
	source: { toolCallId?: string; toolName?: string };
}

export interface AskOptionsAnswer {
	requestId: string;
	picked: string[]; // option labels (length 1 unless multiSelect)
	cancelled?: boolean;
}

export interface UserInputBus {
	askOptions(req: Omit<AskOptionsRequest, "requestId">): Promise<AskOptionsAnswer>;
	onRequest(listener: (req: AskOptionsRequest) => void): () => void;
	resolve(requestId: string, answer: Omit<AskOptionsAnswer, "requestId">): void;
	cancelAll(reason?: string): void;
	/** True when at least one listener has registered. */
	hasListener(): boolean;
}

interface PendingEntry {
	resolve: (answer: AskOptionsAnswer) => void;
	reject: (err: Error) => void;
}

function pickDefaultLabel(req: Pick<AskOptionsRequest, "options">): string {
	const recommended = req.options.find((o) => o.recommended);
	if (recommended) return recommended.label;
	return req.options[0]?.label ?? "";
}

export function createUserInputBus(): UserInputBus {
	const listeners: Array<(req: AskOptionsRequest) => void> = [];
	const pending = new Map<string, PendingEntry>();

	const bus: UserInputBus = {
		askOptions(reqInput) {
			const requestId = randomUUID();
			const req: AskOptionsRequest = { ...reqInput, requestId };

			// No listener bound: deterministic auto-answer using recommended/first.
			if (listeners.length === 0) {
				const label = pickDefaultLabel(req);
				const answer: AskOptionsAnswer = {
					requestId,
					picked: label ? [label] : [],
					cancelled: false,
				};
				return Promise.resolve(answer);
			}

			return new Promise<AskOptionsAnswer>((resolve, reject) => {
				pending.set(requestId, { resolve, reject });
				// Notify listeners synchronously; errors thrown by a listener should
				// not break the bus.
				for (const listener of listeners.slice()) {
					try {
						listener(req);
					} catch (err) {
						// eslint-disable-next-line no-console
						console.error("UserInputBus listener error:", err);
					}
				}
			});
		},

		onRequest(listener) {
			listeners.push(listener);
			return () => {
				const idx = listeners.indexOf(listener);
				if (idx !== -1) listeners.splice(idx, 1);
			};
		},

		resolve(requestId, answer) {
			const entry = pending.get(requestId);
			if (!entry) return;
			pending.delete(requestId);
			entry.resolve({ requestId, ...answer });
		},

		cancelAll(reason) {
			const entries = Array.from(pending.entries());
			pending.clear();
			for (const [requestId, entry] of entries) {
				entry.resolve({ requestId, picked: [], cancelled: true });
			}
			void reason;
		},

		hasListener() {
			return listeners.length > 0;
		},
	};

	return bus;
}

// ---------------------------------------------------------------------------
// Module-level "current session" registry.
//
// Tools receive the bus through their execution context when the agent loop
// is wired to pass it. As a fallback (and to keep wiring minimal across the
// many session-creation paths), modes can publish the active bus here and
// tools can pull it on demand. This mirrors the pattern used by other
// process-global resources in the coding-agent (see `event-bus.ts`).
// ---------------------------------------------------------------------------

let currentUserInputBus: UserInputBus | undefined;

export function setCurrentUserInputBus(bus: UserInputBus | undefined): void {
	currentUserInputBus = bus;
}

export function getCurrentUserInputBus(): UserInputBus | undefined {
	return currentUserInputBus;
}
