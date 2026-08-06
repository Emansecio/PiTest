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
import { getCurrentSelfReviewFindings } from "../self-review.ts";
import { summarizeCheckFailure } from "../verification/failure-summary.ts";
import { detectGoalGateCommands, runGoalGates } from "../verification/goal-gates.ts";
import { pendingVerificationJobs } from "../verification/pending-checks.ts";
import { getCurrentVerificationProbe, getCurrentVerificationSettings } from "../verification/verification.ts";
import { listBashBackgroundJobs } from "./bash.ts";
import { renderToolOutput } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const goalCompleteSchema = Type.Object(
	{
		summary: Type.Optional(
			Type.String({
				description: "Short summary of what was accomplished and how each requirement was verified.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type GoalCompleteToolInput = Static<typeof goalCompleteSchema>;

export interface GoalCompleteToolDetails {
	completed: boolean;
	objective?: string;
}

export interface GoalCompleteToolOptions {}

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
	_options?: GoalCompleteToolOptions,
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
			// R8: a test/check the agent backgrounded is still running — its result is
			// unknown, so the goal can't be declared done (and no commit suggested) yet.
			const pending = pendingVerificationJobs(listBashBackgroundJobs());
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
			const mutationRevision = goal.mutationRevision ?? 0;
			if (mutationRevision > 0) {
				const verificationSettings = getCurrentVerificationSettings();
				const gates = detectGoalGateCommands(
					cwd,
					verificationSettings?.command ?? undefined,
					goal.mutatedPaths ?? [],
				);
				const gateRun = await runGoalGates(gates, cwd, {
					timeoutMs: verificationSettings?.timeoutMs,
					passedGateIds: mgr.gateProgressFor(mutationRevision),
					signal,
				});
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
					mgr.setGateProgress(mutationRevision, gateRun.passedGateIds);
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
				mgr.setGateProgress(mutationRevision, gateRun.passedGateIds);
			}
			// R7: don't let the agent declare the goal done while the project check
			// is red. Run the configured check once; refuse on failure with the output.
			// A probe that merely TIMED OUT is inconclusive, not red: refusing on it
			// would permanently block goal completion in any repo whose check outruns
			// verification.timeoutMs (the agent can never make a slow check faster).
			const probe = getCurrentVerificationProbe();
			if (probe && mutationRevision === 0) {
				const result = await probe();
				if (result && !result.ok && !result.timedOut) {
					// Summarize the dominant failure (tsc/biome/vitest/thrown) instead of a raw
					// tail slice, so the model sees the root-cause error — same extraction the
					// end-of-turn verification gate uses. Falls back to a tail when nothing matches.
					const tail = summarizeCheckFailure(result.output, "");
					const status = `exited ${result.exitCode}`;
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
			forgetGateRefusals(goal.id);
			mgr.complete(summary);
			return {
				content: [
					{
						type: "text" as const,
						text: `Goal complete: ${goal.objective}${summary ? `\n${summary}` : ""}`,
					},
				],
				details: { completed: true, objective: goal.objective },
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
