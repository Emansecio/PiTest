/**
 * Parallel subagent orchestration — `spawnAll` with concurrency cap and
 * allSettled semantics (one failure does not abort siblings).
 */

import type { AgentTool, ThinkingLevel } from "@pit/agent-core";
import type { Model } from "@pit/ai";
import type { TSchema } from "typebox";
import { mapWithConcurrency } from "../../utils/map-with-concurrency.ts";
import { type AcceptanceConfig, type AcceptanceDependencies, runWithAcceptance } from "./acceptance.ts";
import { getSubagentErrorUsage, spawnSubagent } from "./spawn.ts";
import type { SpawnSubagentOptions, SubagentProgressInfo, SubagentUsage } from "./types.ts";

const DEFAULT_MAX_SUBAGENT_CONCURRENCY = 4;

/** Lifecycle telemetry is best-effort and must never alter task semantics. */
function safeNotify(fn: (() => void) | undefined): void {
	try {
		fn?.();
	} catch {
		// A TUI/event sink failure must not turn a successful child into an error.
	}
}

/** Resolves the horizontal concurrency cap, honoring `PIT_SUBAGENT_MAX_CONCURRENCY`. */
export function resolveMaxSubagentConcurrency(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PIT_SUBAGENT_MAX_CONCURRENCY;
	if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_SUBAGENT_CONCURRENCY;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_SUBAGENT_CONCURRENCY;
	return parsed;
}

export interface ParallelTask {
	name?: string;
	prompt: string;
	allowed_tools?: string[];
	result_schema?: TSchema;
	acceptance?: AcceptanceConfig;
	/** Per-task model override (already resolved by the caller); defaults to `base.model`. */
	model?: Model<any>;
	/** Per-task thinking level; defaults to `base.thinkingLevel`. */
	thinkingLevel?: ThinkingLevel;
	/** Per-task system prompt (e.g. from a reusable agent type); defaults to `base.systemPrompt`. */
	systemPrompt?: string;
	/** Per-task catalog override (used for agent-type-scoped memory/tools). */
	tools?: AgentTool[];
}

export interface ParallelTaskResult {
	taskName: string;
	ok: boolean;
	output?: string;
	value?: unknown;
	error?: string;
	gate?: import("./acceptance.ts").GateDetails;
	/** Aggregate token/cost usage for the task's run, when the provider reported it. */
	usage?: SubagentUsage;
	/** Turns the task's (final) worker run took. */
	turns?: number;
}

export interface SpawnAllOptions {
	concurrency?: number;
	/** Base spawn options merged into every task (depth, cwd, model, signal, …). */
	base: Omit<SpawnSubagentOptions, "prompt" | "allowedTools" | "resultSchema" | "taskName">;
	/** Fired when a task's run starts (handle = task name or `parallel-<i>`), for live TUI status. */
	onTaskStart?: (handle: string) => void;
	/** Per-turn progress for a running task — same shape the single `task` op emits. */
	onTaskEvent?: (handle: string, info: SubagentProgressInfo) => void;
	/** Fired when a task settles, with turns/tokens for the TUI. */
	onTaskComplete?: (handle: string, status: "done" | "error", meta?: { turns?: number; totalTokens?: number }) => void;
}

/**
 * Run multiple subagent tasks concurrently with a cap. Each element reports its
 * own ok/error — partial results are always returned (allSettled semantics).
 */
export async function spawnAll(
	deps: AcceptanceDependencies,
	tasks: ParallelTask[],
	options: SpawnAllOptions,
): Promise<ParallelTaskResult[]> {
	const concurrency = options.concurrency ?? resolveMaxSubagentConcurrency();
	const base = options.base;

	return mapWithConcurrency(tasks, concurrency, async (task, index) => {
		// Stable pre-spawn handle for progress events and the error path; the
		// registry still collision-resolves the final taskName on the result.
		const handle = task.name?.trim() || `parallel-${index + 1}`;
		const spawnOpts: SpawnSubagentOptions = {
			...base,
			prompt: task.prompt,
			allowedTools: task.allowed_tools,
			resultSchema: task.result_schema,
			taskName: task.name ?? handle,
			model: task.model ?? base.model,
			thinkingLevel: task.thinkingLevel ?? base.thinkingLevel,
			systemPrompt: task.systemPrompt ?? base.systemPrompt,
			onSubagentEvent: (info) => safeNotify(() => options.onTaskEvent?.(handle, info)),
		};

		safeNotify(() => options.onTaskStart?.(handle));
		// A typed task may need a distinct scoped catalog (e.g. memory:true binds
		// recall/retain/reflect to that agent type). Keep the shared dependencies
		// immutable and override only this child's catalog.
		const taskDeps = task.tools ? { ...deps, availableTools: task.tools } : deps;
		try {
			if (task.acceptance?.criteria || task.acceptance?.check) {
				const gated = await runWithAcceptance(taskDeps, spawnOpts, task.acceptance);
				safeNotify(() =>
					options.onTaskComplete?.(handle, gated.isError ? "error" : "done", {
						turns: gated.result.record.turnCount,
						totalTokens: gated.usage?.totalTokens,
					}),
				);
				return {
					taskName: gated.result.record.taskName,
					ok: !gated.isError,
					output: gated.text,
					value: gated.result.value,
					gate: gated.gate,
					usage: gated.usage,
					turns: gated.result.record.turnCount,
				};
			}
			const result = await spawnSubagent(taskDeps, spawnOpts);
			safeNotify(() =>
				options.onTaskComplete?.(handle, "done", {
					turns: result.record.turnCount,
					totalTokens: result.usage?.totalTokens,
				}),
			);
			return {
				taskName: result.record.taskName,
				ok: true,
				output: result.output,
				value: result.value,
				usage: result.usage,
				turns: result.record.turnCount,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			safeNotify(() => options.onTaskComplete?.(handle, "error"));
			return {
				taskName: task.name ?? handle,
				ok: false,
				error: message,
				usage: getSubagentErrorUsage(err),
			};
		}
	});
}

/** Re-export for callers that need the default constant. */
export { DEFAULT_MAX_SUBAGENT_CONCURRENCY };
