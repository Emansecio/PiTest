import type { StreamOptions } from "../types.ts";
import { DEFAULT_CONNECT_TIMEOUT_MS } from "./connect-guard.ts";
import { DEFAULT_IDLE_TIMEOUT_MS } from "./idle-timeout.ts";

export interface ResolvedStreamTimeouts {
	connectTimeoutMs: number;
	requestTimeoutMs: number | undefined;
	idleTimeoutMs: number;
}

/** Resolve connect, SDK request, and body idle timeouts from StreamOptions. */
export function resolveStreamTimeouts(options?: StreamOptions): ResolvedStreamTimeouts {
	return {
		connectTimeoutMs: options?.connectTimeoutMs ?? options?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
		requestTimeoutMs: options?.timeoutMs,
		idleTimeoutMs: options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
	};
}
