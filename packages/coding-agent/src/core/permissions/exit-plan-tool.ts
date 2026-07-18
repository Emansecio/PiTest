/**
 * `exit_plan` tool — the model calls this to present its structured plan for
 * user approval, ending the planning phase of plan mode.
 *
 * Why a dedicated tool (not `ask`): approval must atomically flip the
 * PermissionChecker from "plan" (read-only) to "auto". The `ask` tool only
 * returns text to the model — the model cannot (and must not be able to)
 * change its own permission mode. This tool owns that side effect.
 *
 * Fail-closed on the mode flip: in a non-interactive run (print mode, headless
 * subagent) there is no human to approve, and the UserInputBus auto-answers with
 * the recommended/first option. We therefore REFUSE to approve when no
 * interactive listener is bound, and never mark an option `recommended` — so
 * no headless path can leave plan mode without a real human choice.
 * Two more layers keep that invariant when a listener IS bound: "Keep planning"
 * is deliberately the FIRST option (every auto-answer fallback picks
 * recommended-or-first — e.g. the interactive mode auto-resolves a second picker
 * request that arrives while one is already open), and the tool runs
 * `executionMode: "sequential"` so it never shares a parallel tool batch with
 * another UserInputBus prompt in the first place.
 *
 * Fail-open on the durable artifact: the plan is written to
 * `.pit/plans/<timestamp>-<slug>.md` AFTER consent, which is the same harness-
 * side persistence class as session saving (already permitted in plan mode). If
 * the write fails the approval still stands; the result just notes the miss.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import { truncateWithEllipsis } from "../../utils/surrogate.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { getCurrentPlanManager, type PlanStep, topoOrder } from "../plan/plan-manager.ts";
import { getTextOutput, str } from "../tools/render-utils.ts";
import { getCurrentUserInputBus } from "../user-input-bus.ts";
import type { PermissionChecker } from "./checker.ts";

const TITLE_MAX = 80;
const SUMMARY_MAX = 600;
const SLUG_MAX = 40;

const exitPlanSchema = Type.Object(
	{
		title: Type.String({
			description: "Short title for the plan (≤80 chars). Becomes the slug of the saved plan artifact.",
		}),
		summary: Type.Optional(
			Type.String({
				description:
					"2-4 sentences framing the plan: the goal, the approach, and any key trade-off. Shown above the DAG.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type ExitPlanToolInput = Static<typeof exitPlanSchema>;

export interface ExitPlanToolDetails {
	outcome: "approved" | "keep_planning" | "feedback" | "unavailable" | "no_plan" | "not_plan_mode";
	/** Path of the written artifact, when approval succeeded and the write worked. */
	artifactPath?: string;
	/** Reason text for error/unavailable outcomes. */
	reason?: string;
}

export interface ExitPlanToolOptions {
	cwd: string;
	checker: PermissionChecker;
	/** Fired after approval flipped the checker to "auto" (host refreshes UI status + swaps model role). */
	onApproved?: () => void;
}

const APPROVE_LABEL = "Approve & execute";
const KEEP_LABEL = "Keep planning";

function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, SLUG_MAX);
	return slug.length > 0 ? slug : "plan";
}

/** `YYYYMMDD-HHMM` in local time — lexicographically sortable filename prefix. */
function timestampPrefix(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function renderStepForArtifact(step: PlanStep): string {
	const deps = step.dependsOn.length > 0 ? ` [needs ${step.dependsOn.join(", ")}]` : "";
	const produces = step.producesArtifact ? ` → ${step.producesArtifact}` : "";
	const verify = step.verifyCmd ? ` ⟨${step.verifyCmd}⟩` : "";
	return `- [${step.status}] ${step.id}: ${step.intent}${deps}${produces}${verify}`;
}

/** Write the approved plan to `.pit/plans/<timestamp>-<slug>.md`. Returns the path or throws. */
function writePlanArtifact(
	cwd: string,
	title: string,
	summary: string | undefined,
	version: { version: number; steps: PlanStep[]; brief?: string },
): string {
	const dir = join(cwd, ".pit", "plans");
	const file = join(dir, `${timestampPrefix(new Date())}-${slugify(title)}.md`);
	const stepLines = topoOrder(version.steps).map(renderStepForArtifact);
	const frontmatter = [
		"---",
		`title: ${title}`,
		`date: ${new Date().toISOString()}`,
		`planVersion: ${version.version}`,
		"---",
	].join("\n");
	const sections: string[] = [frontmatter, ""];
	if (summary) {
		sections.push("## Summary", "", summary, "");
	}
	if (version.brief) {
		sections.push("## Brief", "", version.brief, "");
	}
	sections.push("## Steps (topological order)", "", ...stepLines, "");
	const body = sections.join("\n");
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, body, "utf-8");
	return file;
}

export function createExitPlanToolDefinition(
	options: ExitPlanToolOptions,
): ToolDefinition<typeof exitPlanSchema, ExitPlanToolDetails> {
	return {
		name: "exit_plan",
		label: "exit_plan",
		description:
			"Present the current structured plan (`plan`) for user approval and, on approval, switch the session out of plan mode into execution. Only available in plan mode; requires a plan created with `plan propose`. In non-interactive runs the approval is refused (stays in plan mode).",
		promptSnippet: "Present the structured plan for user approval and exit plan mode",
		promptGuidelines: [
			"Call `exit_plan` only after building the plan with `plan propose`; never present an un-built plan.",
		],
		parameters: exitPlanSchema,
		sideEffect: "none",
		// Never share a parallel batch with another UserInputBus prompt: a second
		// concurrent picker request is auto-resolved with the first option, which
		// must not be able to race an approval (see header).
		executionMode: "sequential",
		async execute(_toolCallId, input) {
			const title = truncateWithEllipsis((input.title ?? "").trim(), TITLE_MAX);
			const summary = input.summary?.trim() ? truncateWithEllipsis(input.summary.trim(), SUMMARY_MAX) : undefined;

			// 1. Guard: only meaningful in plan mode. Tool stays registered in every
			//    mode so the surface is stable; the guard is internal.
			if (options.checker.mode !== "plan") {
				return {
					content: [{ type: "text" as const, text: "exit_plan is only available in plan mode." }],
					isError: true as const,
					details: { outcome: "not_plan_mode", reason: "exit_plan is only available in plan mode." },
				};
			}

			// 2. Guard: a structured plan must exist — the rito requires a DAG, not a
			//    prose plan in the message body.
			const mgr = getCurrentPlanManager();
			if (!mgr || mgr.isEmpty()) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No structured plan to present. Build one with `plan propose` (steps + brief + verify) before calling exit_plan.",
						},
					],
					isError: true as const,
					details: {
						outcome: "no_plan",
						reason: "No structured plan to present. Build one with `plan propose` first.",
					},
				};
			}

			// 3. Fail-closed: without a real interactive listener the bus would
			//    auto-answer, which must NEVER approve a mode flip. Refuse and stay.
			const bus = getCurrentUserInputBus();
			if (!bus || !bus.hasListener()) {
				return {
					content: [
						{
							type: "text" as const,
							text: "User approval unavailable in non-interactive mode; staying in plan mode.",
						},
					],
					details: {
						outcome: "unavailable",
						reason: "User approval unavailable in non-interactive mode; staying in plan mode.",
					},
				};
			}

			// 4. Ask. No option is `recommended` AND the safe choice is listed first —
			//    every auto-answer fallback picks recommended-or-first, so any path
			//    that bypasses a real human (headless bus, picker-collision
			//    auto-resolve) lands on "Keep planning", never on approval.
			const current = mgr.current();
			const context = `${summary ? `${summary}\n\n` : ""}${mgr.render()}`;
			const answer = await bus.askOptions({
				question: "Approve this plan and switch to execution?",
				context,
				options: [{ label: KEEP_LABEL }, { label: APPROVE_LABEL }],
				allowFreeform: true,
				source: { toolCallId: _toolCallId, toolName: "exit_plan" },
			});

			// 5a. Cancelled or explicit "keep planning" — stay in plan mode.
			if (answer.cancelled || answer.picked.includes(KEEP_LABEL)) {
				const comment = answer.comment?.trim() || answer.freeformText?.trim() || undefined;
				const text = comment
					? `User chose to keep planning. Feedback: ${comment}`
					: "User chose to keep planning. Revise the plan (`plan revise`) and call exit_plan again.";
				return {
					content: [{ type: "text" as const, text }],
					details: { outcome: "keep_planning", reason: comment },
				};
			}

			// 5b. Freeform without an approve pick — treat as feedback, stay in plan.
			if (answer.freeformText && answer.picked.length === 0) {
				const feedback = answer.freeformText.trim();
				return {
					content: [
						{
							type: "text" as const,
							text: `User feedback: ${feedback}. Revise the plan (\`plan revise\`) and call exit_plan again.`,
						},
					],
					details: { outcome: "feedback", reason: feedback },
				};
			}

			// 5c. Approval. Flip the checker, write the artifact (fail-open), notify host.
			if (answer.picked.includes(APPROVE_LABEL)) {
				options.checker.updateMode("auto");
				let artifactPath: string | undefined;
				let note = "";
				if (current) {
					try {
						artifactPath = writePlanArtifact(options.cwd, title || "plan", summary, current);
					} catch {
						note = " (plan artifact could not be written)";
					}
				}
				// The mode is already committed, so a throwing host handler (footer
				// refresh, role swap) must NOT fail the tool — that would desync the
				// role/footer from the checker. Fail-open like the artifact write above.
				try {
					options.onApproved?.();
				} catch {
					note += " (post-approval host refresh failed)";
				}
				const text = `Plan approved. Permission mode is now auto. Execute the plan following the step DAG; mark steps done with \`plan step_done\`.${artifactPath ? ` Plan artifact: ${artifactPath}` : ""}${note}`;
				return {
					content: [{ type: "text" as const, text }],
					details: { outcome: "approved", artifactPath },
				};
			}

			// Defensive: any other answer shape stays in plan mode.
			return {
				content: [
					{ type: "text" as const, text: "Staying in plan mode. Revise the plan and call exit_plan again." },
				],
				details: { outcome: "keep_planning" },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const rawTitle = str(args?.title);
			const titleText = rawTitle ? truncateWithEllipsis(rawTitle, 80) : "(missing)";
			text.setText(`${theme.fg("toolTitle", theme.bold("exit_plan"))} ${theme.fg("accent", titleText)}`);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result, context.showImages).trim();
			text.setText(output ? theme.fg("toolOutput", output) : "");
			return text;
		},
	};
}
