/**
 * `goal_complete` tool — lets the agent explicitly mark the current autonomous
 * goal as finished. Mirrors the `@narumitw/pi-goal` completion tool: the model
 * must verify every requirement before calling it. It reaches the active
 * GoalManager through the module-level registry and is a no-op when no goal is
 * active.
 */

import type { AgentTool } from "@pit/agent-core";
import { recordDiagnostic } from "@pit/ai";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import { getCurrentCoveringTests, getCurrentUnreviewedImpact } from "../built-ins/impact-extension.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { getCurrentGoalManager } from "../goal/goal-manager.ts";
import {
	type GoalCompleteCriterionInput,
	type GoalCompletionReceipt,
	type GoalCompletionReceiptDraft,
	validateGoalEvidence,
} from "../goal/goal-receipt.ts";
import { getCurrentSelfReviewFindings } from "../self-review.ts";
import { summarizeCheckFailure } from "../verification/failure-summary.ts";
import {
	detectGoalGateCommands,
	type GoalGateRunResult,
	goalGateFingerprint,
	runGoalGates,
} from "../verification/goal-gates.ts";
import {
	isVerificationJobCommand,
	pendingVerificationJobs,
	verificationJobVerdict,
} from "../verification/pending-checks.ts";
import {
	type CheckResult,
	getCurrentVerificationProbe,
	getCurrentVerificationSettings,
} from "../verification/verification.ts";
import { listBashBackgroundJobs } from "./bash.ts";
import { renderToolOutput } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const goalCompleteSchema = Type.Object(
	{
		summary: Type.Optional(Type.String({ maxLength: 1200, description: "Short completion summary." })),
		contractRevision: Type.Optional(Type.Integer({ minimum: 1 })),
		criteria: Type.Optional(
			Type.Array(
				Type.Object({
					id: Type.String(),
					outcome: Type.String({ maxLength: 600 }),
					evidence: Type.Array(
						Type.Union([
							Type.Object({
								kind: Type.Literal("path"),
								path: Type.String(),
								note: Type.Optional(Type.String({ maxLength: 400 })),
							}),
							Type.Object({ kind: Type.Literal("claim"), note: Type.String({ maxLength: 400 }) }),
						]),
					),
				}),
			),
		),
	},
	{ additionalProperties: false },
);

export type GoalCompleteToolInput = Static<typeof goalCompleteSchema>;

export interface GoalCompleteToolDetails {
	completed: boolean;
	objective?: string;
	receipt?: GoalCompletionReceipt;
	code?: string;
	pendingCriteria?: string[];
}

export interface GoalCompleteToolOptions {
	getOwnerSessionId?: () => string | undefined;
}

/**
 * One refusal per goal, per gate — the bound that makes R9/R10 terminate.
 *
 * A gate that can refuse the SAME goal indefinitely is a doom-loop generator: when
 * the model cannot clear the condition (a self-review finding it believes is a
 * false positive, an impacted file it already judged safe), every `goal_complete`
 * hits the same wall and the goal never ends. That is the failure mode the R7 gate
 * produced, and it is why comparable harnesses bound their completion policy
 * instead of blocking on it — zero's `completion_policy.go` caps its continue
 * nudges (`maxContinueNudges`) and then accepts the turn. A completion policy has
 * to be designed to terminate.
 *
 * So each gate spends exactly one refusal per goal: the first call surfaces the
 * concrete list, and a second call completes even if the condition still stands.
 * The refusal already told the model what to check; from there the judgment is
 * the model's, and a warn-level diagnostic records that the gate was waived.
 *
 * R8 (a backgrounded check still running) is deliberately NOT bounded: it clears
 * on its own the moment the job exits, so it cannot wedge a goal.
 */
const selfReviewRefusedGoals = new Set<string>();
const impactRefusedGoals = new Set<string>();

/**
 * Spend this goal's single refusal for one gate. Returns true when the gate may
 * refuse (first time for this goal), false once it is spent and the gate must
 * fall through to completion.
 */
function spendGateRefusal(spent: Set<string>, goalId: string): boolean {
	if (spent.has(goalId)) return false;
	spent.add(goalId);
	return true;
}

/** Drop a finished goal's refusal bookkeeping so the sets track only live goals. */
function forgetGateRefusals(goalId: string): void {
	selfReviewRefusedGoals.delete(goalId);
	impactRefusedGoals.delete(goalId);
}

/** Test seam: clear the per-goal refusal ledger between cases. */
export function _resetGoalCompleteGateStateForTest(): void {
	selfReviewRefusedGoals.clear();
	impactRefusedGoals.clear();
}

/** Cap on seeds shown per R10 bullet line before folding the rest into "+N". */
const R10_SEEDS_CAP = 2;
/** Cap on covering-test paths shown in the R10 "run them" line before folding into "+N more". */
const R10_TESTS_CAP = 5;

/** Render `(impacted by: seed1, seed2, +N)` — the edit(s) that made a file show up in R10's list. */
function formatImpactedBySeeds(seeds: readonly string[]): string {
	const shown = seeds.slice(0, R10_SEEDS_CAP);
	const remaining = seeds.length - shown.length;
	return remaining > 0 ? `${shown.join(", ")}, +${remaining}` : shown.join(", ");
}

/** Render the "Tests covering the changed files (run them): ..." line, or "" when there are none. */
function formatCoveringTestsLine(coveringTests: readonly string[]): string {
	if (coveringTests.length === 0) return "";
	const shown = coveringTests.slice(0, R10_TESTS_CAP);
	const remaining = coveringTests.length - shown.length;
	const more = remaining > 0 ? `, +${remaining} more` : "";
	return `\nTests covering the changed files (run them): ${shown.join(", ")}${more}`;
}

export function createGoalCompleteToolDefinition(
	cwd: string,
	options?: GoalCompleteToolOptions,
): ToolDefinition<typeof goalCompleteSchema, GoalCompleteToolDetails> {
	return {
		name: "goal_complete",
		label: "goal_complete",
		executionMode: "sequential",
		description:
			"Mark the current autonomous goal as complete. Call this ONLY after every requirement of the goal is satisfied AND verified requirement-by-requirement against real output (tests, files, command results). No-op if no goal is active.",
		promptSnippet: "Mark the active goal complete (only after verifying every requirement)",
		parameters: goalCompleteSchema,
		async execute(_toolCallId: string, input: GoalCompleteToolInput, signal?: AbortSignal) {
			const mgr = getCurrentGoalManager();
			const goal = mgr?.get();
			if (!mgr || !goal || goal.status === "complete") {
				return {
					content: [{ type: "text" as const, text: "No active goal to complete." }],
					details: { completed: false },
				};
			}
			if (goal.status !== "active") {
				return {
					content: [
						{
							type: "text" as const,
							text:
								"Not completing the goal — it is " +
								goal.status +
								". Resume or raise the relevant limit before completing it.",
						},
					],
					details: { completed: false, objective: goal.objective },
				};
			}
			const contractRevision = goal.contract?.revision;
			const mutationRevision = goal.mutationRevision ?? 0;
			const goalIsUnchanged = (): boolean => {
				const current = mgr.get();
				return (
					current?.id === goal.id &&
					current.status === "active" &&
					current.contract?.revision === contractRevision &&
					(current.mutationRevision ?? 0) === mutationRevision
				);
			};
			const goalChangedResult = () => ({
				content: [
					{
						type: "text" as const,
						text: "Not completing the goal — the Goal changed while verification was running. Re-evaluate the current Goal contract and call goal_complete again.",
					},
				],
				details: { completed: false, objective: goal.objective, code: "goal-changed" },
			});
			let validatedCriteria: ReturnType<typeof validateGoalEvidence>["criteria"] = [];
			if (goal.contract) {
				if (input.contractRevision !== goal.contract.revision || !input.criteria) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Not completing the goal — provide contractRevision ${goal.contract.revision} and criteria for: ${goal.contract.criteria.map((criterion) => criterion.id).join(", ")}.`,
							},
						],
						details: {
							completed: false,
							objective: goal.objective,
							code: "contract-required",
							pendingCriteria: goal.contract.criteria.map((criterion) => criterion.id),
						},
					};
				}
				const evidence = validateGoalEvidence(
					goal.contract,
					input.criteria as GoalCompleteCriterionInput[],
					cwd,
					goal.mutatedPaths ?? [],
				);
				if (!evidence.valid)
					return {
						content: [
							{
								type: "text" as const,
								text: `Not completing the goal — evidence coverage is invalid:\n${evidence.errors.map((error) => `- ${error}`).join("\n")}`,
							},
						],
						details: { completed: false, objective: goal.objective, code: "invalid-evidence" },
					};
				validatedCriteria = evidence.criteria;
			}
			// R8: a test/check the agent backgrounded — its result is
			// unknown, so the goal can't be declared done (and no commit suggested) yet.
			const verificationJobs = listBashBackgroundJobs(options?.getOwnerSessionId?.()).filter((job) =>
				isVerificationJobCommand(job.command),
			);
			const pending = pendingVerificationJobs(verificationJobs);
			const failedVerification = verificationJobs.filter((job) => {
				if (job.resultSeen) return false;
				const verdict = verificationJobVerdict(job);
				return verdict === "failed" || verdict === "timed-out";
			});
			if (pending.length > 0) {
				const list = pending.map((j) => `  • id=${j.id}: ${j.command}`).join("\n");
				return {
					content: [
						{
							type: "text" as const,
							text: `Not completing the goal — a test/check is still running in the background. Wait for it to finish and confirm it passed, then call goal_complete again:\n${list}`,
						},
					],
					details: { completed: false, objective: goal.objective },
				};
			}
			if (failedVerification.length > 0) {
				const list = failedVerification.map((job) => `  • id=${job.id}: ${job.command}`).join("\n");
				return {
					content: [
						{
							type: "text" as const,
							text: `Not completing the goal — a verification job failed or timed out. Inspect its output before correcting or rerunning it:\n${list}`,
						},
					],
					details: { completed: false, objective: goal.objective },
				};
			}
			const verificationSettings = getCurrentVerificationSettings();
			let gateRun: GoalGateRunResult | undefined;
			let gates: ReturnType<typeof detectGoalGateCommands> = [];
			let cachedGateIds = new Set<string>();
			let gateFingerprints: Record<string, string> = {};
			if (mutationRevision > 0 && verificationSettings?.enabled !== false) {
				gates = detectGoalGateCommands(cwd, verificationSettings?.command ?? undefined, goal.mutatedPaths ?? []);
				gateFingerprints = Object.fromEntries(gates.map((gate) => [gate.id, goalGateFingerprint(gate)]));
				cachedGateIds = new Set(mgr.gateProgressFor(mutationRevision, gateFingerprints));
				gateRun = await runGoalGates(gates, cwd, {
					timeoutMs: verificationSettings?.timeoutMs,
					passedGateIds: [...cachedGateIds],
					signal,
				});
				if (!goalIsUnchanged()) return goalChangedResult();
				const failed = gateRun.results.find((result) => result.status === "failed");
				if (gateRun.status === "cancelled") {
					mgr.pause("gate_cancelled");
					return {
						content: [
							{
								type: "text" as const,
								text: "Not completing the goal — gate execution was cancelled. The Goal is paused; resume after deciding how to continue.",
							},
						],
						details: { completed: false, objective: goal.objective },
					};
				}
				if (failed) {
					mgr.setGateProgress(mutationRevision, gateRun.passedGateIds, gateFingerprints);
					const failure = mgr.recordGateFailure(mutationRevision, failed.gate.id, failed.fingerprint);
					const repeated = failure.attempts >= 3;
					if (repeated) mgr.pause("gate_retry_limit");
					recordDiagnostic({
						category: "quality.in-turn-check",
						level: "warn",
						source: "goal-complete.goal-gates",
						context: { note: `${failed.gate.id} ${failed.status} attempt=${failure.attempts}` },
					});
					const output = failed.output || "(no output)";
					return {
						content: [
							{
								type: "text" as const,
								text: `Not completing the goal — gate ${failed.index}/${failed.total} (${failed.gate.label}) failed${repeated ? " three times; the Goal is paused" : ""}. Fix the cause, then call goal_complete again:\n\n${output}`,
							},
						],
						details: { completed: false, objective: goal.objective },
					};
				}
				mgr.setGateProgress(mutationRevision, gateRun.passedGateIds, gateFingerprints);
			}
			// R7: don't let the agent declare the goal done while the project check
			// is red. Run the configured check once; refuse on failure with the output.
			// A probe that merely TIMED OUT is inconclusive, not red: refusing on it
			// would permanently block goal completion in any repo whose check outruns
			// verification.timeoutMs (the agent can never make a slow check faster).
			const probe = getCurrentVerificationProbe();
			let probeResult: CheckResult | null | undefined;
			if (probe && mutationRevision === 0) {
				probeResult = await probe();
				if (!goalIsUnchanged()) return goalChangedResult();
				if (probeResult && !probeResult.ok && !probeResult.timedOut) {
					// Summarize the dominant failure (tsc/biome/vitest/thrown) instead of a raw
					// tail slice, so the model sees the root-cause error — same extraction the
					// end-of-turn verification gate uses. Falls back to a tail when nothing matches.
					const tail = summarizeCheckFailure(probeResult.output, "");
					const status = `exited ${probeResult.exitCode}`;
					return {
						content: [
							{
								type: "text" as const,
								text: `Not completing the goal — the project check ${status}. Fix the cause, then call goal_complete again:\n\n${tail || "(no output)"}`,
							},
						],
						details: { completed: false, objective: goal.objective },
					};
				}
			}
			// R9: a structured self-review (Band P / P4) of this cycle's high-risk diff
			// found high-severity problems that were never resolved. Refuse completion
			// with the concrete findings — same shape as the R7/R8 refusals above.
			const reviewFindings = getCurrentSelfReviewFindings();
			if (reviewFindings.length > 0) {
				if (spendGateRefusal(selfReviewRefusedGoals, goal.id)) {
					const list = reviewFindings
						.map((f) => `  • [${f.file}] ${f.claim}\n    evidence: ${f.evidence}`)
						.join("\n");
					recordDiagnostic({
						category: "quality.self-review",
						level: "warn",
						source: "goal-complete",
						context: { ruleId: "review-blocked-done", note: `high findings=${reviewFindings.length}` },
					});
					return {
						content: [
							{
								type: "text" as const,
								text: `Not completing the goal — a self-review of your changes found unresolved high-severity problems. Fix these (or explain why each is a false positive), then call goal_complete again:\n${list}`,
							},
						],
						details: { completed: false, objective: goal.objective },
					};
				}
				// Refusal already spent for this goal — the model saw the findings and came
				// back anyway. Let it through and record that the gate was waived.
				recordDiagnostic({
					category: "quality.self-review",
					level: "warn",
					source: "goal-complete",
					context: { ruleId: "review-gate-waived", note: `high findings=${reviewFindings.length}` },
				});
			}
			// R10: the native import graph (Fase 2, `built-ins/impact-extension.ts`)
			// found direct dependents of this turn's edits that were never read,
			// edited, or lsp-checked afterward. Refuse completion with the concrete
			// list — same shape as the R7/R8/R9 refusals above.
			const unreviewedImpact = getCurrentUnreviewedImpact();
			if (unreviewedImpact.length > 0) {
				if (spendGateRefusal(impactRefusedGoals, goal.id)) {
					const shown = unreviewedImpact.slice(0, 10);
					const list = shown
						.map(
							(e) =>
								`  • ${e.path}${e.seeds.length > 0 ? ` (impacted by: ${formatImpactedBySeeds(e.seeds)})` : ""}`,
						)
						.join("\n");
					const more =
						unreviewedImpact.length > shown.length ? `\n  +${unreviewedImpact.length - shown.length} more` : "";
					const testsLine = formatCoveringTestsLine(getCurrentCoveringTests());
					recordDiagnostic({
						category: "quality.impact-guard",
						level: "warn",
						source: "goal-complete",
						context: { ruleId: "impact-blocked-done", note: `unreviewed=${unreviewedImpact.length}` },
					});
					return {
						content: [
							{
								type: "text" as const,
								text: `Not completing the goal — the import graph shows ${unreviewedImpact.length} file(s) that depend on what you changed and were never reviewed this turn. Read them (or run lsp diagnostics on them) to confirm they still work, then call goal_complete again:\n${list}${more}${testsLine}`,
							},
						],
						details: { completed: false, objective: goal.objective },
					};
				}
				// Refusal already spent for this goal — the model saw the list and came back
				// anyway. Let it through and record that the gate was waived.
				recordDiagnostic({
					category: "quality.impact-guard",
					level: "warn",
					source: "goal-complete",
					context: { ruleId: "impact-gate-waived", note: `unreviewed=${unreviewedImpact.length}` },
				});
			}
			const summary = input.summary?.trim();
			const contract = goal.contract;
			const gateReceipts: GoalCompletionReceipt["verification"]["gates"] = [];
			if (gateRun) {
				for (const gate of gates) {
					const result = gateRun.results.find((item) => item.gate.id === gate.id);
					if (result?.status === "passed") {
						gateReceipts.push({
							id: gate.id,
							label: gate.label,
							source: gate.source,
							status: "passed",
							cached: false,
							durationMs: result.durationMs,
						});
					} else if (cachedGateIds.has(gate.id) && gateRun.passedGateIds.includes(gate.id)) {
						gateReceipts.push({
							id: gate.id,
							label: gate.label,
							source: gate.source,
							status: "passed",
							cached: true,
						});
					}
				}
			}
			const verification: GoalCompletionReceipt["verification"] =
				mutationRevision > 0
					? verificationSettings?.enabled === false
						? {
								mechanism: "none",
								status: "inapplicable",
								reason: "verification disabled",
								gates: [],
							}
						: {
								mechanism: "goal-gates",
								status: gateRun?.status === "passed" ? "passed" : "inapplicable",
								reason: gateRun?.status === "inapplicable" ? gateRun.reason : undefined,
								gates: gateReceipts,
							}
					: probe
						? {
								mechanism: "legacy-probe",
								status: probeResult?.ok ? "passed" : "inapplicable",
								reason:
									probeResult === null
										? "verification probe returned no result"
										: probeResult?.timedOut
											? "verification probe timed out"
											: undefined,
								gates: [],
							}
						: {
								mechanism: "none",
								status: "inapplicable",
								reason: "no applicable verification mechanism",
								gates: [],
							};
			const receiptDraft: GoalCompletionReceiptDraft | undefined = contract
				? {
						version: 1,
						goalId: goal.id,
						objective: goal.objective,
						contractRevision: contract.revision,
						criteria: validatedCriteria,
						mutations: {
							revision: mutationRevision,
							paths: goal.mutatedPaths ?? [],
							attribution:
								mutationRevision === 0 ? "not_applicable" : goal.mutatedPaths?.length ? "known" : "unknown",
						},
						verification,
						safeguards: {
							pendingVerificationChecks: "clear",
							selfReview:
								reviewFindings.length > 0
									? "waived"
									: selfReviewRefusedGoals.has(goal.id)
										? "passed"
										: "not_applicable",
							impactReview:
								unreviewedImpact.length > 0
									? "waived"
									: impactRefusedGoals.has(goal.id)
										? "passed"
										: "not_applicable",
						},
					}
				: undefined;
			if (!goalIsUnchanged()) return goalChangedResult();
			const completion = mgr.complete(summary, receiptDraft);
			if (!completion.completed && completion.receiptBytes !== undefined) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Not completing the goal — the completion receipt exceeds the 24 KiB limit. Shorten criterion outcomes or evidence notes, then call goal_complete again.",
						},
					],
					details: { completed: false, objective: goal.objective, code: "receipt-too-large" },
				};
			}
			if (!completion.completed) return goalChangedResult();
			const receipt = completion.receipt;
			forgetGateRefusals(goal.id);
			return {
				content: [
					{
						type: "text" as const,
						text: `Goal complete: ${goal.objective}\nContract: ${validatedCriteria.length}/${goal.contract?.criteria.length ?? validatedCriteria.length} covered · verification ${receipt?.verification.status ?? "inapplicable"} · ${goal.mutatedPaths?.length ?? 0} changed files${summary ? `\n${summary}` : ""}`,
					},
				],
				details: { completed: true, objective: goal.objective, receipt },
			};
		},
		renderCall(_args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold("goal_complete")));
			return text;
		},
		renderResult: renderToolOutput,
	};
}

export function createGoalCompleteTool(
	cwd: string,
	options?: GoalCompleteToolOptions,
): AgentTool<typeof goalCompleteSchema> {
	return wrapToolDefinition(createGoalCompleteToolDefinition(cwd, options));
}
