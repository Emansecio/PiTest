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
import type {
	SpawnSubagentOptions,
	SpawnSubagentResult,
	SubagentProgressInfo,
	SubagentUsage,
	WorktreeSpec,
} from "./types.ts";
import { retargetToolsForWorktree } from "./worktree-tools.ts";

const execFileP = promisify(execFile);

const JUDGE_READONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export const MAX_ACCEPTANCE_ATTEMPTS = 8;
export const DEFAULT_ACCEPTANCE_CHECK_TIMEOUT_MS = 120_000;
const MAX_ACCEPTANCE_CHECK_TIMEOUT_MS = 10 * 60_000;

const JUDGE_RESULT_SCHEMA = Type.Object({
	pass: Type.Boolean(),
	reasons: Type.String(),
	missing: Type.Optional(Type.Array(Type.String())),
});

export interface AcceptanceConfig {
	criteria?: string;
	check?: string;
	max_attempts?: number;
	check_timeout_ms?: number;
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

export interface AcceptanceLifecycleCallbacks {
	/** Stable parent-visible prefix for the gate's attempt/phase lifecycle rows. */
	handlePrefix: string;
	onStart?: (handle: string) => void;
	onProgress?: (handle: string, info: SubagentProgressInfo) => void;
	onComplete?: (
		handle: string,
		status: "done" | "error" | "cancelled",
		meta?: { turns?: number; totalTokens?: number },
	) => void;
}

export interface AcceptanceDependencies extends SpawnSubagentDependencies {
	permissionChecker?: PermissionChecker;
	/** Best-effort telemetry for individual gate attempts; never affects the verdict. */
	acceptanceLifecycle?: AcceptanceLifecycleCallbacks;
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

function lifecycleHandle(
	lifecycle: AcceptanceLifecycleCallbacks | undefined,
	attempt: number,
	phase: "worker" | "judge" | "check",
): string | undefined {
	return lifecycle ? `${lifecycle.handlePrefix} [attempt ${attempt} ${phase}]` : undefined;
}

function emitLifecycle(
	lifecycle: AcceptanceLifecycleCallbacks | undefined,
	kind: "onStart" | "onProgress" | "onComplete",
	...args:
		| [string, SubagentProgressInfo?]
		| [string, "done" | "error" | "cancelled", { turns?: number; totalTokens?: number }?]
): void {
	try {
		if (kind === "onStart") lifecycle?.onStart?.(args[0]);
		else if (kind === "onProgress") lifecycle?.onProgress?.(args[0], args[1] as SubagentProgressInfo);
		else
			lifecycle?.onComplete?.(
				args[0],
				args[1] as "done" | "error" | "cancelled",
				args[2] as { turns?: number; totalTokens?: number } | undefined,
			);
	} catch {
		// Lifecycle is telemetry only; it must not change gate semantics.
	}
}

async function runCheckCommand(
	command: string,
	cwd: string,
	checker: PermissionChecker | undefined,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<{ pass: boolean; outputTail: string }> {
	if (checker) {
		const decision = checker.check(describeToolAction("bash", { command }));
		// An acceptance check runs inside the coordinator, not inside a turn with a
		// UI: there is no one to approve a `confirm` deferral, so it fails the gate
		// exactly like a deny. Pre-approve the check command via `allowCommands` to
		// run acceptance under confirm mode.
		if (decision.decision !== "allow") {
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
			timeout: timeoutMs,
			signal,
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
	attempt: number,
): Promise<{ pass: boolean; reasons: string; missing?: string[]; usage?: SubagentUsage }> {
	const workerDepth = spawnOpts.depth ?? 0;
	const judgePrompt =
		"You are an acceptance judge. Evaluate whether the worker output satisfies the criteria. " +
		"Use read-only tools to verify file/claim evidence when needed.\n\n" +
		`## Criteria\n${criteria}\n\n## Worker output\n${workerOutput}`;

	const handle = lifecycleHandle(deps.acceptanceLifecycle, attempt, "judge");
	emitLifecycle(deps.acceptanceLifecycle, "onStart", handle ?? "");
	let judgeResult: SpawnSubagentResult;
	try {
		judgeResult = await spawnSubagent(deps, {
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
			onSubagentEvent: handle
				? (info) => emitLifecycle(deps.acceptanceLifecycle, "onProgress", handle, info)
				: undefined,
		});
	} catch (error) {
		emitLifecycle(
			deps.acceptanceLifecycle,
			"onComplete",
			handle ?? "",
			spawnOpts.signal?.aborted ? "cancelled" : "error",
		);
		throw error;
	}
	const value = judgeResult.value as { pass: boolean; reasons: string; missing?: string[] } | undefined;
	if (!value) {
		emitLifecycle(deps.acceptanceLifecycle, "onComplete", handle ?? "", "error", {
			turns: judgeResult.record.turnCount,
			totalTokens: judgeResult.usage?.totalTokens,
		});
		return { pass: false, reasons: "judge produced no valid verdict", usage: judgeResult.usage };
	}
	emitLifecycle(deps.acceptanceLifecycle, "onComplete", handle ?? "", value.pass ? "done" : "error", {
		turns: judgeResult.record.turnCount,
		totalTokens: judgeResult.usage?.totalTokens,
	});
	return { ...value, usage: judgeResult.usage };
}

async function evaluateGate(
	deps: AcceptanceDependencies,
	spawnOpts: SpawnSubagentOptions,
	acceptance: AcceptanceConfig,
	workerResult: SpawnSubagentResult,
	attempt: number,
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
		const verdict = await evaluateCriteria(deps, acceptance.criteria, output, spawnOpts, attempt);
		criteriaPass = verdict.pass;
		usage = verdict.usage;
		if (!verdict.pass) {
			reasons = verdict.reasons;
		}
	}

	if (acceptance.check) {
		const handle = lifecycleHandle(deps.acceptanceLifecycle, attempt, "check");
		emitLifecycle(deps.acceptanceLifecycle, "onStart", handle ?? "");
		const check = await runCheckCommand(
			acceptance.check,
			spawnOpts.cwd ?? process.cwd(),
			deps.permissionChecker,
			spawnOpts.signal,
			acceptance.check_timeout_ms ?? DEFAULT_ACCEPTANCE_CHECK_TIMEOUT_MS,
		);
		emitLifecycle(deps.acceptanceLifecycle, "onProgress", handle ?? "", { turn: 1, lastTool: "bash" });
		emitLifecycle(deps.acceptanceLifecycle, "onComplete", handle ?? "", check.pass ? "done" : "error", {
			turns: 1,
		});
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
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ACCEPTANCE_ATTEMPTS) {
		throw new RangeError(`acceptance.max_attempts must be an integer >= 1 and <= ${MAX_ACCEPTANCE_ATTEMPTS}`);
	}
	const checkTimeoutMs = acceptance.check_timeout_ms ?? DEFAULT_ACCEPTANCE_CHECK_TIMEOUT_MS;
	if (
		!Number.isInteger(checkTimeoutMs) ||
		checkTimeoutMs < 1_000 ||
		checkTimeoutMs > MAX_ACCEPTANCE_CHECK_TIMEOUT_MS
	) {
		throw new RangeError(
			`acceptance.check_timeout_ms must be an integer >= 1000 and <= ${MAX_ACCEPTANCE_CHECK_TIMEOUT_MS}`,
		);
	}
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
			const workerHandle = lifecycleHandle(deps.acceptanceLifecycle, attempt, "worker");
			emitLifecycle(deps.acceptanceLifecycle, "onStart", workerHandle ?? "");
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
					onSubagentEvent: workerHandle
						? (info) => emitLifecycle(deps.acceptanceLifecycle, "onProgress", workerHandle, info)
						: spawnOpts.onSubagentEvent,
				});
				emitLifecycle(deps.acceptanceLifecycle, "onComplete", workerHandle ?? "", "done", {
					turns: lastResult.record.turnCount,
					totalTokens: lastResult.usage?.totalTokens,
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
					attempt,
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
			} catch (error) {
				emitLifecycle(
					deps.acceptanceLifecycle,
					"onComplete",
					workerHandle ?? "",
					spawnOpts.signal?.aborted ? "cancelled" : "error",
				);
				throw error;
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
		isError: true,
		text,
		gate,
		usage,
	};
}

/** Exported for unit tests — filter judge-eligible tools from a catalog. */
export function filterJudgeTools(catalog: readonly AgentTool[]): AgentTool[] {
	return judgeTools(catalog);
}
