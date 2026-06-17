/**
 * `goal_complete` tool — lets the agent explicitly mark the current autonomous
 * goal as finished. Mirrors the `@narumitw/pi-goal` completion tool: the model
 * must verify every requirement before calling it. It reaches the active
 * GoalManager through the module-level registry and is a no-op when no goal is
 * active.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { getCurrentGoalManager } from "../goal/goal-manager.ts";
import { summarizeCheckFailure } from "../verification/failure-summary.ts";
import { getCurrentVerificationProbe } from "../verification/verification.ts";
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
			// R7: don't let the agent declare the goal done while the project check
			// is red. Run the configured check once; refuse on failure with the output.
			const probe = getCurrentVerificationProbe();
			if (probe) {
				const result = await probe();
				if (result && !result.ok) {
					// Summarize the dominant failure (tsc/biome/vitest/thrown) instead of a raw
					// tail slice, so the model sees the root-cause error — same extraction the
					// end-of-turn verification gate uses. Falls back to a tail when nothing matches.
					const tail = summarizeCheckFailure(result.output, "");
					const status = result.timedOut ? "timed out" : `exited ${result.exitCode}`;
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
