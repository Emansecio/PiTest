/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentEvent, AgentMessage, ThinkingLevel } from "@pit/agent-core";
import type { ImageContent } from "@pit/ai";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type { RpcCommand, RpcResponse, RpcSessionState, RpcSlashCommand } from "./rpc-types.ts";

// ============================================================================
// Types
// ============================================================================

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Additional CLI arguments */
	args?: string[];
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

export type RpcEventListener = (event: AgentEvent) => void;

/**
 * Cap on retained subprocess stderr. The buffer is only ever interpolated into
 * error messages, so retaining the child's entire lifetime of stderr is both
 * unnecessary and an OOM risk on long-lived sessions with chatty children. Keep
 * the most recent slice — that's where a crash's cause usually is.
 */
const STDERR_MAX_BYTES = 65536;

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
	private pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	/**
	 * Active waiters from waitForIdle()/collectEvents(). Unlike pendingRequests
	 * these don't have an RPC id — they settle on an agent_end event or their own
	 * timeout. Tracking them here lets failPendingAndReset() reject them fast when
	 * the child crashes/exits, instead of leaving them to stall on the timeout.
	 * Each waiter removes itself on normal resolve to avoid a double-settle.
	 */
	private idleWaiters: Set<{ reject: (error: Error) => void }> = new Set();
	private requestId = 0;
	private stderr = "";
	/** Decodes stderr chunks without splitting multibyte UTF-8 across boundaries. */
	private stderrDecoder = new StringDecoder("utf8");
	private options: RpcClientOptions;

	constructor(options: RpcClientOptions = {}) {
		this.options = options;
	}

	/**
	 * Start the RPC agent process.
	 */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client already started");
		}

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		const child = spawn("node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = child;

		// Collect stderr for debugging. Bound the retained buffer to the last
		// STDERR_MAX_BYTES so a long-lived session with a chatty child can't OOM
		// the parent; the buffer is only read into error messages. The decoder
		// keeps multibyte UTF-8 sequences intact across chunk boundaries.
		child.stderr?.on("data", (data) => {
			const chunk = Buffer.isBuffer(data) ? this.stderrDecoder.write(data) : String(data);
			if (chunk.length > 0) {
				const combined = this.stderr + chunk;
				this.stderr = combined.length > STDERR_MAX_BYTES ? combined.slice(-STDERR_MAX_BYTES) : combined;
			}
			process.stderr.write(data);
		});

		// If the agent process dies or errors unexpectedly (segfault, OOM, native
		// addon crash) after the init window below, fail every in-flight request
		// fast instead of letting each one stall on its own 30-60s timeout.
		// stop() sets this.process = null before its cleanup, so the `=== child`
		// guard prevents this from firing during an intentional shutdown.
		child.on("error", (err) => {
			if (this.process !== child) return;
			this.failPendingAndReset(`Agent process error: ${err.message}. Stderr: ${this.stderr}`);
		});
		child.on("exit", (code, signal) => {
			if (this.process !== child) return;
			const how = code !== null ? `code ${code}` : `signal ${signal}`;
			this.failPendingAndReset(`Agent process exited unexpectedly with ${how}. Stderr: ${this.stderr}`);
		});

		// Set up strict JSONL reader for stdout.
		this.stopReadingStdout = attachJsonlLineReader(child.stdout!, (line) => {
			this.handleLine(line);
		});

		// Wait a moment for process to initialize
		await new Promise((resolve) => setTimeout(resolve, 100));

		if (child.exitCode !== null) {
			throw new Error(`Agent process exited immediately with code ${child.exitCode}. Stderr: ${this.stderr}`);
		}
	}

	/**
	 * Reject every in-flight request with the given error and reset the client so
	 * later send() calls fail with "Client not started" rather than hanging.
	 * Mirrors stop()'s pending-request cleanup; safe to call once per termination
	 * (per-request reject wrappers clear their own timeouts and removing entries
	 * before rejecting guards against any later double-settle).
	 */
	private failPendingAndReset(message: string): void {
		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.process = null;
		const pending = Array.from(this.pendingRequests.values());
		this.pendingRequests.clear();
		for (const request of pending) {
			request.reject(new Error(message));
		}
		// waitForIdle()/collectEvents() callers don't live in pendingRequests; fail
		// them here too so a child crash mid-run rejects them immediately instead of
		// leaving them to stall on their own timeout. Each waiter's reject wrapper
		// clears its timer and removes itself from the set.
		const waiters = Array.from(this.idleWaiters);
		this.idleWaiters.clear();
		for (const waiter of waiters) {
			waiter.reject(new Error(message));
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	async stop(): Promise<void> {
		if (!this.process) return;

		this.stopReadingStdout?.();
		this.stopReadingStdout = null;

		// Detach our reference up front so the unexpected-termination handler
		// installed in start() (guarded by `this.process === child`) treats the
		// kill below as an intentional shutdown rather than a crash.
		const child = this.process;
		this.process = null;
		child.kill("SIGTERM");

		// Wait for process to exit
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 1000);

			child.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		for (const pending of this.pendingRequests.values()) {
			pending.reject(new Error("Client stopped"));
		}
		this.pendingRequests.clear();
		// Also release any waitForIdle()/collectEvents() callers so an explicit
		// stop() mid-run doesn't leave them stalled on their own timeout.
		const waiters = Array.from(this.idleWaiters);
		this.idleWaiters.clear();
		for (const waiter of waiters) {
			waiter.reject(new Error("Client stopped"));
		}
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.stderr;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "prompt", message, images });
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "steer", message, images });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "follow_up", message, images });
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}

	/**
	 * Fork from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}

	/**
	 * Clone the current active branch into a new session.
	 * @returns Object with `cancelled: true` if an extension cancelled the clone
	 */
	async clone(): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "clone" });
		return this.getData(response);
	}

	/**
	 * Get messages available for forking.
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}

	/**
	 * Set the session display name.
	 */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * Get all messages in the session.
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Get available commands (extension commands, prompt templates, skills).
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_end event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const cleanup = (): void => {
				clearTimeout(timer);
				unsubscribe();
				this.idleWaiters.delete(waiter);
			};
			const waiter = {
				reject: (error: Error): void => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(error);
				},
			};

			const timer = setTimeout(() => {
				waiter.reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_end" && !settled) {
					settled = true;
					cleanup();
					resolve();
				}
			});

			this.idleWaiters.add(waiter);
		});
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<AgentEvent[]> {
		return new Promise((resolve, reject) => {
			const events: AgentEvent[] = [];
			let settled = false;
			const cleanup = (): void => {
				clearTimeout(timer);
				unsubscribe();
				this.idleWaiters.delete(waiter);
			};
			const waiter = {
				reject: (error: Error): void => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(error);
				},
			};

			const timer = setTimeout(() => {
				waiter.reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				events.push(event);
				if (event.type === "agent_end" && !settled) {
					settled = true;
					cleanup();
					resolve(events);
				}
			});

			this.idleWaiters.add(waiter);
		});
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);

			// Check if it's a response to a pending request
			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				this.pendingRequests.delete(data.id);
				pending.resolve(data as RpcResponse);
				return;
			}

			// Otherwise it's an event
			for (const listener of this.eventListeners) {
				listener(data as AgentEvent);
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	private async send(command: RpcCommandBody): Promise<RpcResponse> {
		if (!this.process?.stdin) {
			throw new Error("Client not started");
		}

		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
			}, 30000);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			this.process!.stdin!.write(serializeJsonLine(fullCommand));
		});
	}

	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
