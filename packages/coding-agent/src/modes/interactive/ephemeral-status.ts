/**
 * Ephemeral status above the editor (not transcript).
 *
 * info / warning auto-dismiss; error stays until the host clears (submit, etc.).
 * Pure timer + kind controller — host supplies paint/clear side effects.
 */

export type EphemeralStatusKind = "info" | "warning" | "error";

export const EPHEMERAL_INFO_TTL_MS = 3500;
export const EPHEMERAL_WARNING_TTL_MS = 6000;

export interface EphemeralStatusHooks {
	/** Paint the colored status line in the UI. */
	paint: (message: string, kind: EphemeralStatusKind) => void;
	/** Remove the status line from the UI. */
	clear: () => void;
	/** Optional clock injection for tests (defaults to setTimeout / clearTimeout). */
	setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimeout?: (id: ReturnType<typeof setTimeout>) => void;
}

export function compactStatusText(message: string): string {
	return message.replace(/\s+/g, " ").trim();
}

function ttlFor(kind: EphemeralStatusKind): number | null {
	switch (kind) {
		case "info":
			return EPHEMERAL_INFO_TTL_MS;
		case "warning":
			return EPHEMERAL_WARNING_TTL_MS;
		case "error":
			return null;
	}
}

export class EphemeralStatusController {
	private hooks: EphemeralStatusHooks;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private active = false;
	private message: string | undefined;
	private kind: EphemeralStatusKind | undefined;

	constructor(hooks: EphemeralStatusHooks) {
		this.hooks = hooks;
	}

	/** Show (or replace) the ephemeral line. Cancels any prior dismiss timer. */
	show(message: string, kind: EphemeralStatusKind = "info"): void {
		const compactMessage = compactStatusText(message);
		const unchanged = this.active && this.message === compactMessage && this.kind === kind;
		this.cancelTimer();
		this.active = true;
		this.message = compactMessage;
		this.kind = kind;
		if (!unchanged) this.hooks.paint(compactMessage, kind);
		const ttl = ttlFor(kind);
		if (ttl === null) return;
		const schedule = this.hooks.setTimeout ?? setTimeout;
		this.timer = schedule(() => {
			this.timer = undefined;
			if (!this.active) return;
			this.active = false;
			this.message = undefined;
			this.kind = undefined;
			this.hooks.clear();
		}, ttl);
	}

	/** Host-driven clear (submit, statusContainer wipe, teardown). */
	clear(): void {
		this.cancelTimer();
		if (!this.active) return;
		this.active = false;
		this.message = undefined;
		this.kind = undefined;
		this.hooks.clear();
	}

	/** Teardown without double-clearing UI when the container was already wiped. */
	dispose(): void {
		this.cancelTimer();
		this.active = false;
		this.message = undefined;
		this.kind = undefined;
	}

	isActive(): boolean {
		return this.active;
	}

	private cancelTimer(): void {
		if (this.timer === undefined) return;
		const cancel = this.hooks.clearTimeout ?? clearTimeout;
		cancel(this.timer);
		this.timer = undefined;
	}
}
