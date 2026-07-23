/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import { type AssistantMessage, getRuntimeDiagnostics, type ImageContent } from "@pit/ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";

/**
 * In `text` mode, stdout carries ONLY the final assistant text (the `-p` contract),
 * so model-provenance events are otherwise invisible — a headless/CI run could
 * consume output from a silently downgraded model (fallback) or after retries were
 * exhausted, with no signal anywhere. This derives the stderr line to surface for
 * such an event (stdout stays untouched). Returns undefined for events that should
 * not be surfaced (incl. successful auto_retry_end). Pure + exported for testing.
 */
export function provenanceStderrLine(event: { type?: string; [k: string]: unknown }): string | undefined {
	if (event.type === "fallback_warning") {
		return `[fallback] model ${event.from} -> ${event.to} (${event.reason})`;
	}
	if (event.type === "auto_retry_end" && event.success === false) {
		const tail = event.finalError ? `: ${event.finalError}` : "";
		return `[retry] gave up after ${event.attempt} attempt(s)${tail}`;
	}
	return undefined;
}

/**
 * Heartbeat cadence for `--mode json`. `message_update` deltas are dropped from
 * the JSONL stream (O(tokens²) to serialize), so a long model round is otherwise
 * completely silent — an external orchestrator cannot tell active generation
 * from a stalled stream or a retry backoff. While a turn is active we emit a
 * throttled `generation_progress` event instead: `elapsedMs` growing with
 * `outputChars` frozen reads as a stall; both growing reads as healthy
 * generation. Kill-switch PIT_NO_JSON_HEARTBEAT=1; cadence override
 * PIT_JSON_HEARTBEAT_MS. Exported for testing.
 */
export const DEFAULT_JSON_HEARTBEAT_MS = 15_000;

export function resolveJsonHeartbeatMs(): number {
	const disable = process.env.PIT_NO_JSON_HEARTBEAT;
	if (disable && ["1", "true", "yes"].includes(disable.toLowerCase())) return 0;
	const raw = process.env.PIT_JSON_HEARTBEAT_MS;
	if (raw === undefined || raw === "") return DEFAULT_JSON_HEARTBEAT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_JSON_HEARTBEAT_MS;
	return parsed;
}

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/**
	 * Wall-clock budget for the whole headless run, in milliseconds (`--max-wall`,
	 * given in seconds on the CLI). When it expires the current turn is aborted so
	 * the run closes with coherent partial state (session saved, diagnostics
	 * flushed) instead of being killed mid-flight by an external orchestrator.
	 * Emits a `max_wall_reached` event (json) or stderr line (text) and exits 124.
	 */
	maxWallMs?: number;
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 *
 * Note: print mode intentionally does NOT bind a listener to the
 * `UserInputBus`. The bus auto-resolves `askOptions` requests with the
 * recommended (or first) option so tools like `ask` stay deterministic
 * in non-interactive runs.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];

	// Turn heartbeat state (json mode only) — see resolveJsonHeartbeatMs.
	const heartbeatMs = mode === "json" ? resolveJsonHeartbeatMs() : 0;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let turnStartedAt = 0;
	let turnOutputChars = 0;
	const stopHeartbeat = (): void => {
		if (heartbeatTimer !== undefined) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
	};
	const startHeartbeat = (): void => {
		turnStartedAt = Date.now();
		turnOutputChars = 0;
		if (heartbeatMs <= 0 || heartbeatTimer !== undefined) return;
		heartbeatTimer = setInterval(() => {
			writeRawStdout(
				`${JSON.stringify({
					type: "generation_progress",
					elapsedMs: Date.now() - turnStartedAt,
					outputChars: turnOutputChars,
				})}\n`,
			);
		}, heartbeatMs);
		(heartbeatTimer as unknown as { unref?: () => void }).unref?.();
	};

	// Wall-clock budget (--max-wall): abort the in-flight turn when it expires so
	// the run closes itself instead of dying to an external SIGKILL mid-implementation.
	let maxWallTimer: ReturnType<typeof setTimeout> | undefined;
	let maxWallHit = false;
	if (options.maxWallMs && options.maxWallMs > 0) {
		maxWallTimer = setTimeout(() => {
			maxWallHit = true;
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify({ type: "max_wall_reached", budgetMs: options.maxWallMs })}\n`);
			} else {
				process.stderr.write(
					`[max-wall] time budget (${options.maxWallMs}ms) reached — closing with partial state\n`,
				);
			}
			void session.abort();
		}, options.maxWallMs);
		(maxWallTimer as unknown as { unref?: () => void }).unref?.();
	}

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					const code = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
					process.exit(code);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			if (mode === "json") {
				// Skip streaming deltas — consumers only need completed messages and
				// lifecycle events; serializing every partial update is O(tokens²).
				// Their delta lengths still feed the heartbeat counter so
				// generation_progress can distinguish generation from a stall.
				if (event.type === "message_update") {
					const delta = (event as { assistantMessageEvent?: { delta?: unknown } }).assistantMessageEvent?.delta;
					if (typeof delta === "string") turnOutputChars += delta.length;
					return;
				}
				if (event.type === "turn_start") startHeartbeat();
				else if (event.type === "turn_end" || event.type === "agent_end") stopHeartbeat();
				writeRawStdout(`${JSON.stringify(event)}\n`);
				return;
			}
			// text mode: surface model-provenance events on stderr (stdout stays the
			// byte-identical `-p` contract), mirroring the diagnostics side-channel below.
			const line = provenanceStderrLine(event);
			if (line) process.stderr.write(`${line}\n`);
		});
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		if (initialMessage && !maxWallHit) {
			await session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			// Budget already spent: don't start further prompts; close with what we have.
			if (maxWallHit) break;
			await session.prompt(message);
		}

		if (mode === "text") {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
				}
			}
		}

		// Surface the otherwise-invisible runtime-diagnostics channel (@pit/ai) at
		// the end of a headless run. In `json` mode it rides the same stdout JSONL
		// stream as a `{type:"diagnostics"}` event (lowest friction, always on). In
		// `text` mode it would corrupt the plain output, so it is opt-in via
		// PIT_DUMP_DIAGNOSTICS and goes to stderr instead.
		const diagnostics = getRuntimeDiagnostics();
		if (diagnostics.total > 0) {
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify({ type: "diagnostics", ...diagnostics })}\n`);
			} else if (process.env.PIT_DUMP_DIAGNOSTICS) {
				process.stderr.write(`${JSON.stringify({ type: "diagnostics", ...diagnostics })}\n`);
			}
		}

		// Timeout convention (same as GNU timeout): lets an orchestrator tell
		// "closed with partial state at the budget" apart from success/failure.
		if (maxWallHit) exitCode = 124;
		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return maxWallHit ? 124 : 1;
	} finally {
		stopHeartbeat();
		if (maxWallTimer !== undefined) clearTimeout(maxWallTimer);
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		// Reap detached bash trees on normal completion (signal path already does).
		killTrackedDetachedChildren();
		await disposeRuntime();
		await flushRawStdout();
	}
}
