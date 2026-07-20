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
import { getCurrentUnreviewedImpact } from "../built-ins/impact-extension.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { getCurrentGoalManager } from "../goal/goal-manager.ts";
import { getCurrentSelfReviewFindings } from "../self-review.ts";
import { summarizeCheckFailure } from "../verification/failure-summary.ts";
import { pendingVerificationJobs } from "../verification/pending-checks.ts";
import { getCurrentVerificationProbe } from "../verification/verification.ts";
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

export function createGoalCompleteToolDefinition(
	_cwd: string,
	_options?: GoalCompleteToolOptions,
): ToolDefinition<typeof goalCompleteSchema, GoalCompleteToolDetails> {
	return {
		name: "goal_complete",
		label: "goal_complete",
		description:
			"Mark the current autonomous goal as complete. Call this ONLY after every requirement of the goal is satisfied AND verified requirement-by-requirement against real output (tests, files, command results). No-op if no goal is active.",
		promptSnippet: "Mark the active goal complete (only after verifying every requirement)",
		promptGuidelines: [
			"Call goal_complete only when the whole goal is done — not a partial result — and you have checked each requirement against real output.",
			"Pass a short summary of what was accomplished and how it was verified.",
		],
		parameters: goalCompleteSchema,
		async execute(_toolCallId: string, input: GoalCompleteToolInput) {
			const mgr = getCurrentGoalManager();
			const goal = mgr?.get();
			if (!mgr || !goal || goal.status === "complete") {
				return {
					content: [{ type: "text" as const, text: "No active goal to complete." }],
					details: { completed: false },
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
			// R7: don't let the agent declare the goal done while the project check
			// is red. Run the configured check once; refuse on failure with the output.
			// A probe that merely TIMED OUT is inconclusive, not red: refusing on it
			// would permanently block goal completion in any repo whose check outruns
			// verification.timeoutMs (the agent can never make a slow check faster).
			const probe = getCurrentVerificationProbe();
			if (probe) {
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
			// R10: the native import graph (Fase 2, `built-ins/impact-extension.ts`)
			// found direct dependents of this turn's edits that were never read,
			// edited, or lsp-checked afterward. Refuse completion with the concrete
			// list — same shape as the R7/R8/R9 refusals above.
			const unreviewedImpact = getCurrentUnreviewedImpact();
			if (unreviewedImpact.length > 0) {
				const shown = unreviewedImpact.slice(0, 10);
				const list = shown.map((e) => `  • ${e.path}`).join("\n");
				const more =
					unreviewedImpact.length > shown.length ? `\n  +${unreviewedImpact.length - shown.length} more` : "";
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
							text: `Not completing the goal — the import graph shows ${unreviewedImpact.length} file(s) that depend on what you changed and were never reviewed this turn. Read them (or run lsp diagnostics on them) to confirm they still work, then call goal_complete again:\n${list}${more}`,
						},
					],
					details: { completed: false, objective: goal.objective },
				};
			}
			const summary = input.summary?.trim();
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
