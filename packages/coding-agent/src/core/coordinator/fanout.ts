/**
 * Fanout orchestration: scout → N reviewers → worker (with optional acceptance).
 */

import type { AgentTool, ThinkingLevel } from "@pit/agent-core";
import type { Model } from "@pit/ai";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { mergeSubagentUsage } from "../token-usage.ts";
import { truncateHeadTail } from "../tools/truncate.ts";
import { type AcceptanceConfig, type AcceptanceDependencies, runWithAcceptance } from "./acceptance.ts";
import { type ParallelTaskResult, resolveMaxSubagentConcurrency, spawnAll, type TaskReservation } from "./parallel.ts";
import { attachSubagentUsageToError, getSubagentErrorUsage, spawnSubagent } from "./spawn.ts";
import type { SpawnSubagentOptions, SubagentProgressInfo, SubagentUsage } from "./types.ts";

/** Lifecycle telemetry is best-effort and must never alter pipeline semantics. */
function safeNotify(fn: (() => void) | undefined): void {
	try {
		fn?.();
	} catch {
		// A TUI/event sink failure must not turn a successful stage into an error.
	}
}

const SCOUT_RESULT_SCHEMA = Type.Object({
	targets: Type.Array(Type.Union([Type.String(), Type.Unknown()]), { maxItems: 32 }),
});
export const MAX_FANOUT_TARGETS = 32;
const MAX_REVIEW_SYNTHESIS_BYTES = 32 * 1024;

export interface FanoutStage {
	prompt: string;
	allowed_tools?: string[];
	result_schema?: TSchema;
	acceptance?: AcceptanceConfig;
	/** Per-stage model override (already resolved by the caller); defaults to the context model. */
	model?: Model<any>;
	/** Per-stage thinking level; defaults to the context level. */
	thinkingLevel?: ThinkingLevel;
	/** Per-stage system prompt (e.g. from a reusable agent type). */
	systemPrompt?: string;
	/** Per-stage catalog override (used for agent-type-scoped memory/tools). */
	tools?: AgentTool[];
	/** Type/role label for this stage's `prompt_cache_key` derivation (see deriveSubagentCacheKey). */
	agentTypeLabel?: string;
}

export interface FanoutReviewerStage {
	prompt_template: string;
	allowed_tools?: string[];
	/** Per-reviewer model override (already resolved) — fan the reviews out on a cheap tier. */
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	systemPrompt?: string;
	tools?: AgentTool[];
	/**
	 * Shared type/role label for every reviewer's `prompt_cache_key`. All N
	 * reviewers run the same prompt template + tools, so one shared label lands
	 * them on the same cache shard (the core fan-out affinity win).
	 */
	agentTypeLabel?: string;
}

export interface FanoutSpec {
	scout: FanoutStage;
	reviewer: FanoutReviewerStage;
	worker: FanoutStage;
	concurrency?: number;
}

export interface FanoutResult {
	targets: unknown[];
	reviews: ParallelTaskResult[];
	worker_output: import("./acceptance.ts").RunWithAcceptanceResult;
	gate?: import("./acceptance.ts").GateDetails;
	/** Scout-run usage, so the caller can record the WHOLE pipeline's spend. */
	scout_usage?: SubagentUsage;
	/** Integral scout output + canonical name, for digest/op:"read" recovery. */
	scout_output?: string;
	scout_task_name?: string;
	/** Collision-resolved registry name of the worker run (for op:"read" recovery). */
	worker_task_name?: string;
}

export interface FanoutContext {
	depth: number;
	cwd: string;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	signal?: AbortSignal;
	/** Fired when a stage/reviewer run starts (handle = fanout-scout / fanout-reviewer-N / fanout-worker). */
	onStageStart?: (handle: string) => void;
	/** Per-turn progress for a running stage — same shape the single `task` op emits. */
	onStageEvent?: (handle: string, info: SubagentProgressInfo) => void;
	/** Fired when a stage settles, with turns/tokens for the TUI. */
	onStageComplete?: (
		handle: string,
		status: "done" | "error" | "cancelled",
		meta?: { turns?: number; totalTokens?: number },
	) => void;
	/** Optional per-stage/reviewer token-budget hold. */
	onStageReserve?: (handle: string) => TaskReservation;
}

/** Simple `{{target}}` templating — objects are JSON-stringified. */
export function substituteTarget(template: string, target: unknown): string {
	const targetStr = typeof target === "string" ? target : JSON.stringify(target);
	// Replacer FUNCTION, not a replacement string: targets come from the scout —
	// paths, selectors, shell snippets — and `$&`, "$`", `$'` and `$$` are all
	// substitution patterns to `String.replace`. A target carrying one silently
	// rewrote itself, and the reviewer was sent to look at the wrong thing.
	return template.replace(/\{\{target\}\}/g, () => targetStr);
}

function formatReviews(reviews: ParallelTaskResult[]): string {
	return reviews
		.map((r) => {
			const status = r.ok ? "ok" : "FAILED";
			const body = r.ok ? (r.output ?? "") : (r.error ?? "unknown error");
			return `### ${r.taskName} [${status}]\n${body}`;
		})
		.join("\n\n");
}

/**
 * Run scout → N reviewers → worker. Reviewer count is determined dynamically by
 * the scout's structured output.
 */
export async function runFanout(
	deps: AcceptanceDependencies,
	spec: FanoutSpec,
	context: FanoutContext,
): Promise<FanoutResult> {
	// Clamped, not just defaulted: past the cap, slots are REJECTED once the wait
	// queue fills rather than queued, so an unclamped spec loses reviewers to
	// "subagent queue full" instead of simply running them a few at a time.
	const concurrency = Math.max(
		1,
		Math.min(spec.concurrency ?? Number.POSITIVE_INFINITY, resolveMaxSubagentConcurrency()),
	);
	const childDepth = context.depth + 1;

	const scoutBase: SpawnSubagentOptions = {
		prompt: spec.scout.prompt,
		allowedTools: spec.scout.allowed_tools,
		resultSchema: SCOUT_RESULT_SCHEMA,
		depth: childDepth,
		cwd: context.cwd,
		model: spec.scout.model ?? context.model,
		thinkingLevel: spec.scout.thinkingLevel ?? context.thinkingLevel,
		signal: context.signal,
		taskName: "fanout-scout",
		agentTypeLabel: spec.scout.agentTypeLabel,
		onSubagentEvent: (info) => safeNotify(() => context.onStageEvent?.("fanout-scout", info)),
	};

	safeNotify(() => context.onStageStart?.("fanout-scout"));
	const scoutReservation = context.onStageReserve?.("fanout-scout");
	if (scoutReservation && !scoutReservation.allowed) {
		safeNotify(() => context.onStageComplete?.("fanout-scout", context.signal?.aborted ? "cancelled" : "error"));
		throw new Error(scoutReservation.reason ?? "Token budget blocks subagent spawn.");
	}
	let scoutResult: Awaited<ReturnType<typeof spawnSubagent>>;
	let scoutUsage: SubagentUsage | undefined;
	try {
		scoutResult = await spawnSubagent(spec.scout.tools ? { ...deps, availableTools: spec.scout.tools } : deps, {
			...scoutBase,
			systemPrompt: spec.scout.systemPrompt,
		});
		scoutUsage = scoutResult.usage;
		safeNotify(() =>
			context.onStageComplete?.("fanout-scout", "done", {
				turns: scoutResult.record.turnCount,
				totalTokens: scoutResult.usage?.totalTokens,
			}),
		);
	} catch (error) {
		scoutUsage = getSubagentErrorUsage(error);
		safeNotify(() => context.onStageComplete?.("fanout-scout", context.signal?.aborted ? "cancelled" : "error"));
		throw error;
	} finally {
		scoutReservation?.record?.(scoutUsage);
		scoutReservation?.release();
	}
	const scoutValue = scoutResult.value as { targets?: unknown[] } | undefined;
	const targets = Array.isArray(scoutValue?.targets) ? scoutValue.targets.slice(0, MAX_FANOUT_TARGETS) : [];

	const reviewerTasks = targets.map((target, i) => ({
		name: `fanout-reviewer-${i}`,
		prompt: substituteTarget(spec.reviewer.prompt_template, target),
		allowed_tools: spec.reviewer.allowed_tools,
		model: spec.reviewer.model,
		thinkingLevel: spec.reviewer.thinkingLevel,
		systemPrompt: spec.reviewer.systemPrompt,
		tools: spec.reviewer.tools,
	}));

	const reviews = await spawnAll(deps, reviewerTasks, {
		concurrency,
		base: {
			depth: childDepth + 1,
			cwd: context.cwd,
			model: context.model,
			thinkingLevel: context.thinkingLevel,
			signal: context.signal,
			// One shared label for all reviewers → same cache shard (fan-out affinity).
			agentTypeLabel: spec.reviewer.agentTypeLabel,
		},
		onTaskStart: context.onStageStart,
		onTaskEvent: context.onStageEvent,
		onTaskComplete: context.onStageComplete,
		onTaskReserve: context.onStageReserve,
	});

	const reviewsText = truncateHeadTail(formatReviews(reviews), { maxBytes: MAX_REVIEW_SYNTHESIS_BYTES }).content;
	const workerPrompt = `${spec.worker.prompt}\n\n## Reviewer findings\n${reviewsText}`;
	const completedUsage = mergeSubagentUsage(scoutResult.usage, ...reviews.map((review) => review.usage));

	safeNotify(() => context.onStageStart?.("fanout-worker"));
	const workerReservation = context.onStageReserve?.("fanout-worker");
	if (workerReservation && !workerReservation.allowed) {
		safeNotify(() => context.onStageComplete?.("fanout-worker", context.signal?.aborted ? "cancelled" : "error"));
		throw new Error(workerReservation.reason ?? "Token budget blocks subagent spawn.");
	}
	let workerOutput: Awaited<ReturnType<typeof runWithAcceptance>>;
	let workerUsage: SubagentUsage | undefined;
	try {
		workerOutput = await runWithAcceptance(
			spec.worker.tools ? { ...deps, availableTools: spec.worker.tools } : deps,
			{
				prompt: workerPrompt,
				allowedTools: spec.worker.allowed_tools,
				resultSchema: spec.worker.result_schema,
				depth: childDepth,
				cwd: context.cwd,
				model: spec.worker.model ?? context.model,
				thinkingLevel: spec.worker.thinkingLevel ?? context.thinkingLevel,
				systemPrompt: spec.worker.systemPrompt,
				signal: context.signal,
				taskName: "fanout-worker",
				agentTypeLabel: spec.worker.agentTypeLabel,
				onSubagentEvent: (info) => safeNotify(() => context.onStageEvent?.("fanout-worker", info)),
			},
			spec.worker.acceptance,
		);
		workerUsage = workerOutput.usage;
		safeNotify(() =>
			context.onStageComplete?.("fanout-worker", workerOutput.isError ? "error" : "done", {
				turns: workerOutput.result.record.turnCount,
				totalTokens: workerOutput.usage?.totalTokens,
			}),
		);
	} catch (error) {
		workerUsage = getSubagentErrorUsage(error);
		safeNotify(() => context.onStageComplete?.("fanout-worker", context.signal?.aborted ? "cancelled" : "error"));
		attachSubagentUsageToError(error, mergeSubagentUsage(completedUsage, getSubagentErrorUsage(error)));
		throw error;
	} finally {
		workerReservation?.record?.(workerUsage);
		workerReservation?.release();
	}

	return {
		targets,
		reviews,
		worker_output: workerOutput,
		gate: workerOutput.gate,
		scout_usage: scoutResult.usage,
		scout_output: scoutResult.output,
		scout_task_name: scoutResult.record.taskName,
		worker_task_name: workerOutput.result.record.taskName,
	};
}
