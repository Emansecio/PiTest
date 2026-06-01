/**
 * UserInputBus
 *
 * In-process request/response bus that lets tool `execute()` implementations
 * ask the active mode for a structured answer mid-turn. The answer is either a
 * set of picked option labels (single- or multi-select) or a freeform string.
 *
 * Pattern:
 *   - Tool calls `bus.askOptions(req)` and awaits the answer.
 *   - Active mode (interactive) calls `bus.onRequest(...)` once, renders an
 *     overlay/picker, and resolves with `bus.resolve(requestId, answer)`.
 *
 * Print / non-interactive mode does NOT subscribe; in that case `askOptions`
 * auto-resolves with the recommended option (or the first option, or an empty
 * freeform answer for option-less prompts) so tools remain deterministic
 * without a UI binding.
 */

import { randomUUID } from "node:crypto";

export interface AskOption {
	label: string;
	description?: string;
	recommended?: boolean;
	value?: string;
}

export interface AskOptionsRequest {
	requestId: string;
	question: string;
	/** Optional background shown above the question. */
	context?: string;
	/** Short chip label rendered above the question. */
	header?: string;
	options: AskOption[];
	/** Allow toggling more than one option (checkbox-style). */
	allowMultiple?: boolean;
	/** Offer a "type a custom answer" path that returns freeform text. */
	allowFreeform?: boolean;
	/** Offer a toggleable comment field attached to the selection. */
	allowComment?: boolean;
	/** Render as a centered overlay (default) or inline above the prompt. */
	displayMode?: "overlay" | "inline";
	/** Key to temporarily hide/show the overlay. Default 'alt+o'. */
	overlayToggleKey?: string;
	/** Key to toggle the comment field. Default 'ctrl+g'. */
	commentToggleKey?: string;
	/** Auto-dismiss after N milliseconds, falling back to the recommended option. */
	timeout?: number;
	source: { toolCallId?: string; toolName?: string };
}

export interface AskOptionsAnswer {
	requestId: string;
	/** Option labels the user picked (length 1 unless allowMultiple). Empty for a freeform answer. */
	picked: string[];
	/** Present when the user typed a custom answer instead of picking an option. */
	freeformText?: string;
	/** Optional comment the user attached to a selection. */
	comment?: string;
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

/**
 * Deterministic auto-answer used when no interactive listener is bound (print
 * mode, headless subagents) or when an interactive prompt times out. Picks the
 * recommended/first option when options exist; otherwise yields an empty
 * freeform answer.
 */
export function computeAutoAnswer(req: Pick<AskOptionsRequest, "options">): Omit<AskOptionsAnswer, "requestId"> {
	if (req.options.length > 0) {
		const label = pickDefaultLabel(req);
		return { picked: label ? [label] : [], cancelled: false };
	}
	return { picked: [], freeformText: "", cancelled: false };
}

function autoAnswer(req: AskOptionsRequest): AskOptionsAnswer {
	return { requestId: req.requestId, ...computeAutoAnswer(req) };
}

export function createUserInputBus(): UserInputBus {
	const listeners: Array<(req: AskOptionsRequest) => void> = [];
	const pending = new Map<string, PendingEntry>();

	const bus: UserInputBus = {
		askOptions(reqInput) {
			const requestId = randomUUID();
			const req: AskOptionsRequest = { ...reqInput, requestId };

			// No listener bound: deterministic auto-answer.
			if (listeners.length === 0) {
				return Promise.resolve(autoAnswer(req));
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
