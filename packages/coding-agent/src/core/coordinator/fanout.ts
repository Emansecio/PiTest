/**
 * Fanout orchestration: scout → N reviewers → worker (with optional acceptance).
 */

import type { AgentTool, ThinkingLevel } from "@pit/agent-core";
import type { Model } from "@pit/ai";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { mergeSubagentUsage } from "../token-usage.ts";
import { type AcceptanceConfig, type AcceptanceDependencies, runWithAcceptance } from "./acceptance.ts";
import { type ParallelTaskResult, resolveMaxSubagentConcurrency, spawnAll } from "./parallel.ts";
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
	targets: Type.Array(Type.Union([Type.String(), Type.Unknown()])),
});

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
}

export interface FanoutReviewerStage {
	prompt_template: string;
	allowed_tools?: string[];
	/** Per-reviewer model override (already resolved) — fan the reviews out on a cheap tier. */
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	systemPrompt?: string;
	tools?: AgentTool[];
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
		status: "done" | "error",
		meta?: { turns?: number; totalTokens?: number },
	) => void;
}

/** Simple `{{target}}` templating — objects are JSON-stringified. */
export function substituteTarget(template: string, target: unknown): string {
	const targetStr = typeof target === "string" ? target : JSON.stringify(target);
	return template.replace(/\{\{target\}\}/g, targetStr);
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
	const concurrency = spec.concurrency ?? resolveMaxSubagentConcurrency();
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
		onSubagentEvent: (info) => safeNotify(() => context.onStageEvent?.("fanout-scout", info)),
	};

	safeNotify(() => context.onStageStart?.("fanout-scout"));
	let scoutResult: Awaited<ReturnType<typeof spawnSubagent>>;
	try {
		scoutResult = await spawnSubagent(spec.scout.tools ? { ...deps, availableTools: spec.scout.tools } : deps, {
			...scoutBase,
			systemPrompt: spec.scout.systemPrompt,
		});
		safeNotify(() =>
			context.onStageComplete?.("fanout-scout", "done", {
				turns: scoutResult.record.turnCount,
				totalTokens: scoutResult.usage?.totalTokens,
			}),
		);
	} catch (error) {
		safeNotify(() => context.onStageComplete?.("fanout-scout", "error"));
		throw error;
	}
	const scoutValue = scoutResult.value as { targets?: unknown[] } | undefined;
	const targets = Array.isArray(scoutValue?.targets) ? scoutValue.targets : [];

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
		},
		onTaskStart: context.onStageStart,
		onTaskEvent: context.onStageEvent,
		onTaskComplete: context.onStageComplete,
	});

	const reviewsText = formatReviews(reviews);
	const workerPrompt = `${spec.worker.prompt}\n\n## Reviewer findings\n${reviewsText}`;
	const completedUsage = mergeSubagentUsage(scoutResult.usage, ...reviews.map((review) => review.usage));

	safeNotify(() => context.onStageStart?.("fanout-worker"));
	let workerOutput: Awaited<ReturnType<typeof runWithAcceptance>>;
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
				onSubagentEvent: (info) => safeNotify(() => context.onStageEvent?.("fanout-worker", info)),
			},
			spec.worker.acceptance,
		);
		safeNotify(() =>
			context.onStageComplete?.("fanout-worker", workerOutput.isError ? "error" : "done", {
				turns: workerOutput.result.record.turnCount,
				totalTokens: workerOutput.usage?.totalTokens,
			}),
		);
	} catch (error) {
		safeNotify(() => context.onStageComplete?.("fanout-worker", "error"));
		attachSubagentUsageToError(error, mergeSubagentUsage(completedUsage, getSubagentErrorUsage(error)));
		throw error;
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
