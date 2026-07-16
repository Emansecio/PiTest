/**
 * Acceptance gates for subagent tasks — semantic criteria (judge subagent) and/or
 * objective shell checks, with retry and graceful degradation on exhaustion.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool } from "@pit/agent-core";
import { Type } from "typebox";
import { describeToolAction, type PermissionChecker } from "../permissions/index.ts";
import { mergeSubagentUsage } from "../token-usage.ts";
import { truncateTail } from "../tools/truncate.ts";
import { isCoordinatorTool } from "./brand.ts";
import {
	attachSubagentUsageToError,
	cleanupSubagentWorktree,
	getSubagentErrorUsage,
	type SpawnSubagentDependencies,
	spawnSubagent,
} from "./spawn.ts";
import type { SpawnSubagentOptions, SpawnSubagentResult, SubagentUsage, WorktreeSpec } from "./types.ts";
import { retargetToolsForWorktree } from "./worktree-tools.ts";

const execFileP = promisify(execFile);

const JUDGE_READONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

const JUDGE_RESULT_SCHEMA = Type.Object({
	pass: Type.Boolean(),
	reasons: Type.String(),
	missing: Type.Optional(Type.Array(Type.String())),
});

export interface AcceptanceConfig {
	criteria?: string;
	check?: string;
	max_attempts?: number;
}

export interface GateDetails {
	passed: boolean;
	exhausted?: boolean;
	attempts: number;
	reasons?: string;
	check_output_tail?: string;
	criteria_pass?: boolean;
	check_pass?: boolean;
}

interface GateVerdict {
	passed: boolean;
	reasons?: string;
	check_output_tail?: string;
	criteria_pass?: boolean;
	check_pass?: boolean;
	/** Judge-subagent usage incurred while evaluating semantic criteria. */
	usage?: SubagentUsage;
}

export interface AcceptanceDependencies extends SpawnSubagentDependencies {
	permissionChecker?: PermissionChecker;
}

export interface RunWithAcceptanceResult {
	result: SpawnSubagentResult;
	isError: boolean;
	text: string;
	gate?: GateDetails;
	usage?: SubagentUsage;
}

function judgeTools(catalog: readonly AgentTool[]): AgentTool[] {
	return catalog.filter((t) => !isCoordinatorTool(t) && (JUDGE_READONLY_TOOLS as readonly string[]).includes(t.name));
}

async function runCheckCommand(
	command: string,
	cwd: string,
	checker: PermissionChecker | undefined,
): Promise<{ pass: boolean; outputTail: string }> {
	if (checker) {
		const decision = checker.check(describeToolAction("bash", { command }));
		if (decision.decision === "deny") {
			return { pass: false, outputTail: decision.reason ?? "permission denied" };
		}
	}
	const shell = process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh";
	const flag = process.platform === "win32" ? "/c" : "-c";
	try {
		const { stdout, stderr } = await execFileP(shell, [flag, command], {
			cwd,
			maxBuffer: 64 * 1024,
			windowsHide: true,
		});
		const combined = `${stdout ?? ""}${stderr ?? ""}`.trim();
		return {
			pass: true,
			outputTail: truncateTail(combined, { maxBytes: 2048 }).content,
		};
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string };
		const combined = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
		return {
			pass: false,
			outputTail: truncateTail(combined, { maxBytes: 2048 }).content,
		};
	}
}

async function evaluateCriteria(
	deps: AcceptanceDependencies,
	criteria: string,
	workerOutput: string,
	spawnOpts: SpawnSubagentOptions,
): Promise<{ pass: boolean; reasons: string; missing?: string[]; usage?: SubagentUsage }> {
	const workerDepth = spawnOpts.depth ?? 0;
	const judgePrompt =
		"You are an acceptance judge. Evaluate whether the worker output satisfies the criteria. " +
		"Use read-only tools to verify file/claim evidence when needed.\n\n" +
		`## Criteria\n${criteria}\n\n## Worker output\n${workerOutput}`;

	const judgeResult = await spawnSubagent(deps, {
		prompt: judgePrompt,
		allowedTools: JUDGE_READONLY_TOOLS.slice(),
		resultSchema: JUDGE_RESULT_SCHEMA,
		depth: workerDepth + 1,
		cwd: spawnOpts.cwd,
		model: spawnOpts.model,
		thinkingLevel: spawnOpts.thinkingLevel,
		signal: spawnOpts.signal,
		systemPrompt:
			"You are an acceptance judge. Verify claims with read-only tools when needed, then deliver a JSON verdict.",
	});
	const value = judgeResult.value as { pass: boolean; reasons: string; missing?: string[] } | undefined;
	if (!value) {
		return { pass: false, reasons: "judge produced no valid verdict", usage: judgeResult.usage };
	}
	return { ...value, usage: judgeResult.usage };
}

async function evaluateGate(
	deps: AcceptanceDependencies,
	spawnOpts: SpawnSubagentOptions,
	acceptance: AcceptanceConfig,
	workerResult: SpawnSubagentResult,
): Promise<GateVerdict> {
	const output =
		spawnOpts.resultSchema && workerResult.value !== undefined
			? JSON.stringify(workerResult.value, null, 2)
			: workerResult.output;

	let criteriaPass: boolean | undefined;
	let checkPass: boolean | undefined;
	let reasons: string | undefined;
	let checkOutputTail: string | undefined;
	let usage: SubagentUsage | undefined;

	if (acceptance.criteria) {
		const verdict = await evaluateCriteria(deps, acceptance.criteria, output, spawnOpts);
		criteriaPass = verdict.pass;
		usage = verdict.usage;
		if (!verdict.pass) {
			reasons = verdict.reasons;
		}
	}

	if (acceptance.check) {
		const check = await runCheckCommand(acceptance.check, spawnOpts.cwd ?? process.cwd(), deps.permissionChecker);
		checkPass = check.pass;
		checkOutputTail = check.outputTail;
		if (!check.pass && !reasons) {
			reasons = check.outputTail || "check command failed";
		}
	}

	const configured = [acceptance.criteria, acceptance.check].filter(Boolean);
	const passes: boolean[] = [];
	if (acceptance.criteria) passes.push(criteriaPass === true);
	if (acceptance.check) passes.push(checkPass === true);

	return {
		passed: configured.length > 0 && passes.every(Boolean),
		reasons,
		check_output_tail: checkOutputTail,
		criteria_pass: criteriaPass,
		check_pass: checkPass,
		usage,
	};
}

function formatGateFeedback(verdict: GateVerdict): string {
	const parts: string[] = [];
	if (verdict.reasons) parts.push(verdict.reasons);
	if (verdict.check_output_tail) parts.push(verdict.check_output_tail);
	return parts.join(" / ") || "gate failed";
}

function addUsage(total: SubagentUsage, usage: SubagentUsage | undefined): void {
	Object.assign(total, mergeSubagentUsage(total, usage));
}

function usesAutoCleanupWorktree(worktree: SpawnSubagentOptions["worktree"]): boolean {
	return worktree === true || (!!worktree && typeof worktree === "object" && worktree.cleanup !== "keep");
}

function usesKeptWorktree(worktree: SpawnSubagentOptions["worktree"]): boolean {
	return !!worktree && typeof worktree === "object" && worktree.cleanup === "keep";
}

function keepWorktree(worktree: SpawnSubagentOptions["worktree"]): WorktreeSpec | undefined {
	if (!worktree) return undefined;
	if (worktree === true) return { cleanup: "keep" };
	return { ...worktree, cleanup: "keep" };
}

/**
 * Spawn a worker via `spawnSubagent`, optionally evaluating an acceptance gate
 * with retries and graceful degradation on exhaustion.
 */
export async function runWithAcceptance(
	deps: AcceptanceDependencies,
	spawnOpts: SpawnSubagentOptions,
	acceptance?: AcceptanceConfig,
): Promise<RunWithAcceptanceResult> {
	if (!acceptance?.criteria && !acceptance?.check) {
		const result = await spawnSubagent(deps, spawnOpts);
		return { result, isError: false, text: result.output, usage: result.usage };
	}

	const maxAttempts = acceptance.max_attempts ?? 2;
	let attempt = 0;
	let lastResult: SpawnSubagentResult | undefined;
	let lastVerdict: GateVerdict | undefined;
	let prompt = spawnOpts.prompt;
	// Whole-gate accounting: every rejected worker attempt plus every semantic
	// judge run counts toward the parent token governor, not only the final worker.
	const usage: SubagentUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };

	try {
		while (attempt < maxAttempts) {
			attempt++;
			const autoCleanup = usesAutoCleanupWorktree(spawnOpts.worktree);
			const explicitKeep = usesKeptWorktree(spawnOpts.worktree);
			let attemptWorktreePath: string | undefined;
			let retainAttemptWorktree = false;
			const callerWorktreeReady = spawnOpts.onWorktreeReady;
			try {
				lastResult = await spawnSubagent(deps, {
					...spawnOpts,
					prompt,
					// Acceptance must inspect the worker's actual checkout. Keep an
					// auto-cleanup worktree alive through judge/check, then remove it in
					// this attempt's finally block.
					worktree: autoCleanup ? keepWorktree(spawnOpts.worktree) : spawnOpts.worktree,
					onWorktreeReady: (path) => {
						attemptWorktreePath = path;
						callerWorktreeReady?.(path);
					},
					// Fresh worker each attempt — omit taskName on retries so the registry
					// assigns a unique name instead of colliding.
					taskName: attempt === 1 ? spawnOpts.taskName : undefined,
				});
				addUsage(usage, lastResult.usage);

				const effectiveCwd = attemptWorktreePath ?? spawnOpts.cwd;
				const gateDeps = attemptWorktreePath
					? {
							...deps,
							availableTools: (deps.retargetToolsForCwd ?? retargetToolsForWorktree)(
								deps.availableTools,
								attemptWorktreePath,
							),
						}
					: deps;
				const verdict = await evaluateGate(
					gateDeps,
					{ ...spawnOpts, cwd: effectiveCwd, worktree: undefined },
					acceptance,
					lastResult,
				);
				addUsage(usage, verdict.usage);
				lastVerdict = verdict;

				if (verdict.passed) {
					retainAttemptWorktree = explicitKeep;
					return {
						result: lastResult,
						isError: false,
						text: lastResult.output,
						gate: {
							passed: true,
							attempts: attempt,
							criteria_pass: verdict.criteria_pass,
							check_pass: verdict.check_pass,
							check_output_tail: verdict.check_output_tail,
						},
						usage,
					};
				}

				if (attempt < maxAttempts) {
					const feedback = formatGateFeedback(verdict);
					prompt = `${spawnOpts.prompt}\n\nPrevious attempt rejected: \`${feedback}\`. Address this and retry.`;
				} else {
					// Exhausted: an explicit cleanup:"keep" retains only the FINAL
					// checkout for inspection; every rejected earlier attempt is removed.
					retainAttemptWorktree = explicitKeep;
				}
			} finally {
				if (attemptWorktreePath && (autoCleanup || (explicitKeep && !retainAttemptWorktree))) {
					await cleanupSubagentWorktree(spawnOpts.cwd ?? process.cwd(), attemptWorktreePath);
				}
			}
		}
	} catch (error) {
		// Worker/judge spawn failures carry their own usage. Fold it into the
		// aggregate accumulated so far and propagate that aggregate on the same
		// error object, allowing every coordinator path to charge incurred spend.
		addUsage(usage, getSubagentErrorUsage(error));
		attachSubagentUsageToError(error, usage);
		throw error;
	}

	const gate: GateDetails = {
		passed: false,
		exhausted: true,
		attempts: attempt,
		reasons: lastVerdict?.reasons,
		check_output_tail: lastVerdict?.check_output_tail,
	};
	const warning = `⚠ Acceptance gate not satisfied after ${attempt} attempts — returning last result.`;
	const text = `${warning}\n\n${lastResult?.output ?? ""}`;
	return {
		result: lastResult!,
		isError: false,
		text,
		gate,
		usage,
	};
}

/** Exported for unit tests — filter judge-eligible tools from a catalog. */
export function filterJudgeTools(catalog: readonly AgentTool[]): AgentTool[] {
	return judgeTools(catalog);
}
