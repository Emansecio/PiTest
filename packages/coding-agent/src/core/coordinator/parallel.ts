/**
 * Parallel subagent orchestration — `spawnAll` with concurrency cap and
 * allSettled semantics (one failure does not abort siblings).
 */

import type { TSchema } from "typebox";
import { mapWithConcurrency } from "../../utils/map-with-concurrency.ts";
import { type AcceptanceConfig, type AcceptanceDependencies, runWithAcceptance } from "./acceptance.ts";
import { spawnSubagent } from "./spawn.ts";
import type { SpawnSubagentOptions } from "./types.ts";

const DEFAULT_MAX_SUBAGENT_CONCURRENCY = 4;

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
}

export interface ParallelTaskResult {
	taskName: string;
	ok: boolean;
	output?: string;
	value?: unknown;
	error?: string;
	gate?: import("./acceptance.ts").GateDetails;
}

export interface SpawnAllOptions {
	concurrency?: number;
	/** Base spawn options merged into every task (depth, cwd, model, signal, …). */
	base: Omit<SpawnSubagentOptions, "prompt" | "allowedTools" | "resultSchema" | "taskName">;
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

	return mapWithConcurrency(tasks, concurrency, async (task) => {
		const spawnOpts: SpawnSubagentOptions = {
			...base,
			prompt: task.prompt,
			allowedTools: task.allowed_tools,
			resultSchema: task.result_schema,
			taskName: task.name,
		};

		try {
			if (task.acceptance?.criteria || task.acceptance?.check) {
				const gated = await runWithAcceptance(deps, spawnOpts, task.acceptance);
				return {
					taskName: gated.result.record.taskName,
					ok: !gated.isError,
					output: gated.text,
					value: gated.result.value,
					gate: gated.gate,
				};
			}
			const result = await spawnSubagent(deps, spawnOpts);
			return {
				taskName: result.record.taskName,
				ok: true,
				output: result.output,
				value: result.value,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				taskName: task.name ?? "(unnamed)",
				ok: false,
				error: message,
			};
		}
	});
}

/** Re-export for callers that need the default constant. */
export { DEFAULT_MAX_SUBAGENT_CONCURRENCY };
