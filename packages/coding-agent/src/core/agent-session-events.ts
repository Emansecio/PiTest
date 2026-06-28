/**
 * Session event types and listener bus — extracted from AgentSession so compaction
 * and fusion modules can emit without importing the session class.
 */

import type { AgentEvent, AgentMessage, ThinkingLevel } from "@pit/agent-core";
import type { CompactionResult } from "./compaction/index.ts";
import type { Orchestration } from "./fusion/types.ts";

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "orchestration_changed"; orchestration: Orchestration }
	| { type: "fusion_phase"; label: string }
	| {
			type: "fusion_member";
			/** Panel slot (0-based). Distinguishes identical members in a self-fusion
			 * (e.g. two claude-opus-4-8) that would otherwise collide on cli/model. */
			index: number;
			cli: string;
			model: string;
			status: "running" | "done" | "failed";
			elapsedMs: number;
			/** Hard wall-clock cap, so the live strip can show "running Ns / Ts". */
			timeoutMs?: number;
			/** Idle cap (ms): the strip shows an "idle Ns / Ts" countdown when the member goes
			 * quiet, since that — not the wall-clock cap — is what actually kills a stuck member. */
			idleTimeoutMs?: number;
			chars?: number;
			error?: string;
	  }
	| { type: "fusion_stage"; stage: "brief" | "panel" | "verify" | "judge" | "writer"; synthId: string }
	| {
			/** Live advisor activity (claude stream-json): what panel slot `index` is
			 * doing right now — thinking, writing, or invoking a tool. Lets the panel
			 * show real work (tool counts) instead of an opaque "running" clock. */
			type: "fusion_member_activity";
			index: number;
			kind: "thinking" | "writing" | "tool" | "tool_result";
			tool?: string;
			/** Snippet of the latest thinking/assistant text, so the strip can show WHAT the
			 * advisor is thinking/writing (claude stream-json). Undefined for tool events. */
			text?: string;
	  }
	| {
			/** Live verify-stage activity: the read-only verifier subagent finished a turn.
			 * Surfaces "turn N · <last tool>" so the verify phase isn't an opaque clock. */
			type: "fusion_verify_activity";
			turn: number;
			tool?: string;
	  }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "fallback_warning"; from: string; to: string; reason: string }
	| {
			type: "verification";
			phase: "running" | "passed" | "failed";
			command: string;
			attempt: number;
			maxAttempts: number;
			exitCode?: number;
			willRetry?: boolean;
	  }
	| { type: "visual_review"; file: string }
	| { type: "subagent_start"; handle: string }
	| { type: "subagent_progress"; handle: string; turn: number; lastTool?: string }
	| { type: "subagent_complete"; handle: string; status: "done" | "error"; turns?: number; totalTokens?: number };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

export interface AgentSessionEventBusDeps {
	onListenerError(event: AgentSessionEvent, err: unknown): void;
}

/**
 * Isolated listener delivery for AgentSession events.
 * A faulty subscriber must not abort the emit loop.
 */
export class AgentSessionEventBus {
	private readonly _deps: AgentSessionEventBusDeps;
	private _listeners: AgentSessionEventListener[] = [];

	constructor(deps: AgentSessionEventBusDeps) {
		this._deps = deps;
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this._listeners.push(listener);
		return () => {
			const index = this._listeners.indexOf(listener);
			if (index !== -1) {
				this._listeners.splice(index, 1);
			}
		};
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this._listeners) {
			try {
				listener(event);
			} catch (err) {
				this._deps.onListenerError(event, err);
			}
		}
	}

	clear(): void {
		this._listeners = [];
	}
}
