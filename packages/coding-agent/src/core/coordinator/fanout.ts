/**
 * Fanout orchestration: scout → N reviewers → worker (with optional acceptance).
 */

import type { ThinkingLevel } from "@pit/agent-core";
import type { Model } from "@pit/ai";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { type AcceptanceConfig, type AcceptanceDependencies, runWithAcceptance } from "./acceptance.ts";
import { type ParallelTaskResult, resolveMaxSubagentConcurrency, spawnAll } from "./parallel.ts";
import { spawnSubagent } from "./spawn.ts";
import type { SpawnSubagentOptions } from "./types.ts";

const SCOUT_RESULT_SCHEMA = Type.Object({
	targets: Type.Array(Type.Union([Type.String(), Type.Unknown()])),
});

export interface FanoutStage {
	prompt: string;
	allowed_tools?: string[];
	result_schema?: TSchema;
	acceptance?: AcceptanceConfig;
}

export interface FanoutReviewerStage {
	prompt_template: string;
	allowed_tools?: string[];
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
}

export interface FanoutContext {
	depth: number;
	cwd: string;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	signal?: AbortSignal;
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
		model: context.model,
		thinkingLevel: context.thinkingLevel,
		signal: context.signal,
		taskName: "fanout-scout",
	};

	const scoutResult = await spawnSubagent(deps, scoutBase);
	const scoutValue = scoutResult.value as { targets?: unknown[] } | undefined;
	const targets = Array.isArray(scoutValue?.targets) ? scoutValue.targets : [];

	const reviewerTasks = targets.map((target, i) => ({
		name: `fanout-reviewer-${i}`,
		prompt: substituteTarget(spec.reviewer.prompt_template, target),
		allowed_tools: spec.reviewer.allowed_tools,
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
	});

	const reviewsText = formatReviews(reviews);
	const workerPrompt = `${spec.worker.prompt}\n\n## Reviewer findings\n${reviewsText}`;

	const workerOutput = await runWithAcceptance(
		deps,
		{
			prompt: workerPrompt,
			allowedTools: spec.worker.allowed_tools,
			resultSchema: spec.worker.result_schema,
			depth: childDepth,
			cwd: context.cwd,
			model: context.model,
			thinkingLevel: context.thinkingLevel,
			signal: context.signal,
			taskName: "fanout-worker",
		},
		spec.worker.acceptance,
	);

	return {
		targets,
		reviews,
		worker_output: workerOutput,
		gate: workerOutput.gate,
	};
}
