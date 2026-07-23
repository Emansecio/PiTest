/**
 * `plan` tool — a STRUCTURED, versionable plan: a DAG of steps for long,
 * multi-phase work with dependencies and verify hints. Secondary to the flat
 * `todo` list (ADR-0007 / CONTEXT.md): use plan when deps/verification matter,
 * not for everyday task tracking.
 *
 * Compaction: the active plan is reconstructed verbatim on demand via
 * `op:"show"`, and PlanManager.systemPromptSection() re-emits it per-turn, so
 * the plan never depends on the original `propose` message surviving history
 * compaction.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import { type BashResult, executeBashWithOperations } from "../bash-executor.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { getCurrentPlanManager, type PlanStep, type PlanStepInput, PlanValidationError } from "../plan/plan-manager.ts";
import { coerceJsonArrayField } from "./argument-prep.ts";
import { createLocalBashOperations } from "./bash.ts";
import { getTextOutput } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { truncateHeadTail } from "./truncate.ts";

const stepSchema = Type.Object(
	{
		id: Type.String({ description: "Stable step id, referenced by other steps' depends_on (e.g. 's1')." }),
		intent: Type.String({ description: "Short outcome-focused goal of this step." }),
		depends_on: Type.Optional(
			Type.Array(Type.String(), { description: "Ids of steps that must finish before this one." }),
		),
		produces: Type.Optional(Type.String({ description: "Artifact this step produces (file/symbol/output)." })),
		verify: Type.Optional(
			Type.String({
				description:
					"Command that proves this step is done. Runs automatically on step_done (60s timeout); a non-zero exit/timeout blocks completion and returns the failure output instead.",
			}),
		),
	},
	{ additionalProperties: false },
);

const planSchema = Type.Object(
	{
		op: Type.Union(
			[Type.Literal("propose"), Type.Literal("revise"), Type.Literal("step_done"), Type.Literal("show")],
			{
				description:
					"propose: create v1 from steps. revise: new version vN+1 (keeps history). step_done: mark a step done. show: print the current DAG.",
			},
		),
		steps: Type.Optional(Type.Array(stepSchema, { description: "Step set for propose/revise (the DAG nodes)." })),
		step_id: Type.Optional(Type.String({ description: "Step id for step_done." })),
		brief: Type.Optional(
			Type.String({
				description:
					"Markdown context the executor needs: constraints, invariants, key files read, decisions made and why. Inherited by revise when omitted. Used by exit_plan to present the plan.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type PlanToolInput = Static<typeof planSchema>;
type PlanStepArg = Static<typeof stepSchema>;

/** Coerce JSON-stringified `steps` arrays before schema validation. */
export function preparePlanArguments(input: unknown): PlanToolInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input as PlanToolInput;
	return coerceJsonArrayField(input as Record<string, unknown>, "steps") as PlanToolInput;
}

export interface PlanToolDetails {
	op: PlanToolInput["op"];
	version: number;
	steps: PlanStep[];
	error?: string;
}

/** Executes a step's `verify` command; returns the same shape as the bash executor. Overridable so tests never spawn a real shell. */
export type PlanStepVerifyRunner = (cmd: string, cwd: string, signal: AbortSignal) => Promise<BashResult>;

export interface PlanToolOptions {
	/**
	 * Verify executor for `step_done` (P8a). Defaults to the project's local bash
	 * executor (bash-executor.ts's `executeBashWithOperations` + `createLocalBashOperations`,
	 * the same infra `!`-prefixed shell commands use) — override only for tests.
	 */
	runStepVerify?: PlanStepVerifyRunner;
}

/** Hard timeout for a step's verify command. Fixed by design — not model/user configurable. */
const STEP_VERIFY_TIMEOUT_MS = 60_000;
/** Byte budget for the head+tail excerpt of verify output kept in a failure result. */
const VERIFY_OUTPUT_MAX_BYTES = 2000;

function isStepVerifyDisabled(): boolean {
	return isTruthyEnvFlag(process.env.PIT_NO_STEP_VERIFY);
}

/** Default verify runner: the same local-shell backend the `!` bash path uses, no spare-pool
 * (this call has no bounded dispose lifecycle to safely own a pooled spare). */
async function defaultRunStepVerify(cmd: string, cwd: string, signal: AbortSignal): Promise<BashResult> {
	return executeBashWithOperations(cmd, cwd, createLocalBashOperations(), { signal });
}

interface VerifyOutcome {
	ok: boolean;
	/** Populated only when !ok: reason + capped output + a short fix-and-retry instruction. */
	message: string;
}

function verifyFailureMessage(cmd: string, reason: string, output?: string): string {
	const lines = [`verify failed: ${reason}`, `command: ${cmd}`];
	const trimmed = output?.trim();
	if (trimmed) {
		lines.push("", truncateHeadTail(trimmed, { maxBytes: VERIFY_OUTPUT_MAX_BYTES }).content);
	}
	lines.push("", "Fix the issue and call `plan step_done` again, or `plan revise` if the verify command is wrong.");
	return lines.join("\n");
}

/**
 * Run a step's verify command under a fixed timeout, never throwing — any exec/spawn
 * failure becomes a readable VerifyOutcome instead of an unhandled rejection. A caller
 * abort (turn interrupt) is honored alongside the internal timeout.
 */
async function runStepVerify(
	cmd: string,
	cwd: string,
	runner: PlanStepVerifyRunner,
	callerSignal: AbortSignal | undefined,
): Promise<VerifyOutcome> {
	const timeoutSignal = AbortSignal.timeout(STEP_VERIFY_TIMEOUT_MS);
	const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
	let result: BashResult;
	try {
		result = await runner(cmd, cwd, signal);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, message: verifyFailureMessage(cmd, `could not start (${reason})`) };
	}
	if (result.cancelled) {
		return {
			ok: false,
			message: verifyFailureMessage(cmd, `timed out after ${STEP_VERIFY_TIMEOUT_MS}ms`, result.output),
		};
	}
	if (result.exitCode !== 0) {
		const codeLabel =
			result.exitCode === undefined ? "no exit code (process killed)" : `exit code ${result.exitCode}`;
		return { ok: false, message: verifyFailureMessage(cmd, codeLabel, result.output) };
	}
	return { ok: true, message: "" };
}

function toStepInputs(steps: PlanStepArg[] | undefined): PlanStepInput[] {
	if (!Array.isArray(steps)) return [];
	return steps.map((s) => ({
		id: s.id,
		intent: s.intent,
		dependsOn: s.depends_on,
		producesArtifact: s.produces,
		verifyCmd: s.verify,
	}));
}

/**
 * Advisory (fail-open) note listing steps that have no `verify` check. Not an
 * error: a plan without verify commands is still valid, but every code-changing
 * step should carry one so completion is provable. Returns "" when all steps
 * have verify (or there are none).
 */
function verifyMissingNote(steps: PlanStep[]): string {
	const missing = steps.filter((s) => !s.verifyCmd || !s.verifyCmd.trim()).map((s) => s.id);
	if (missing.length === 0) return "";
	return `note: steps without verify: ${missing.join(", ")} — add a check that proves each step done`;
}

export function createPlanToolDefinition(
	cwd: string,
	options?: PlanToolOptions,
): ToolDefinition<typeof planSchema, PlanToolDetails> {
	const verifyRunner = options?.runStepVerify ?? defaultRunStepVerify;
	const snapshot = () => {
		const mgr = getCurrentPlanManager();
		const cur = mgr?.current();
		return { version: cur?.version ?? 0, steps: cur?.steps ?? [] };
	};
	const fail = (op: PlanToolInput["op"], message: string) => ({
		content: [{ type: "text" as const, text: message }],
		isError: true as const,
		details: { op, ...snapshot(), error: message },
	});

	return {
		name: "plan",
		label: "plan",
		description:
			"Maintain a structured plan as a DAG of steps. Ops: propose (needs steps; creates v1), revise (needs steps; appends a new version keeping history), step_done (needs step_id), show (print the current DAG in topological order). Each step has id, intent, optional depends_on (ids), produces (artifact), verify (check). Cyclic or dangling depends_on are rejected. The optional `brief` carries markdown context the executor needs and is shown by exit_plan.",
		promptSnippet: "Plan multi-step work as a versioned DAG of dependent steps",
		promptGuidelines: [
			"When a multi-step task has real dependencies/artifacts, prefer `plan` (a DAG) over `todo` (a flat list); mark steps done as you go and `revise` to re-shape. Todo remains the everyday tracker (ADR-0007).",
			"Fill `brief` with the context the executor needs (constraints, invariants, key files read, decisions and why); every code-changing step should have `produces` and `verify`.",
			"step_done runs the step's `verify` command (60s timeout) before marking it done; a failing/timed-out verify blocks completion and returns the capped output — fix and retry step_done, or `revise` if the verify command itself is wrong.",
		],
		parameters: planSchema,
		prepareArguments: preparePlanArguments,
		async execute(_toolCallId: string, input: PlanToolInput, signal?: AbortSignal) {
			const mgr = getCurrentPlanManager();
			if (!mgr) return fail(input.op, "Plan is unavailable in this session.");

			switch (input.op) {
				case "propose": {
					try {
						const version = mgr.propose(toStepInputs(input.steps), input.brief);
						const note = verifyMissingNote(version.steps);
						const body = note ? `${mgr.render()}\n\n${note}` : mgr.render();
						return {
							content: [{ type: "text" as const, text: body }],
							details: { op: "propose" as const, version: version.version, steps: version.steps },
						};
					} catch (error) {
						if (error instanceof PlanValidationError) return fail("propose", error.message);
						throw error;
					}
				}
				case "revise": {
					try {
						const version = mgr.revise(toStepInputs(input.steps), input.brief);
						const diff = mgr.diffFromPrevious();
						const note = verifyMissingNote(version.steps);
						let body = diff ? `${mgr.render()}\n\nchanges:\n${diff}` : mgr.render();
						if (note) body += `\n\n${note}`;
						return {
							content: [{ type: "text" as const, text: body }],
							details: { op: "revise" as const, version: version.version, steps: version.steps },
						};
					} catch (error) {
						if (error instanceof PlanValidationError) return fail("revise", error.message);
						throw error;
					}
				}
				case "step_done": {
					if (!input.step_id?.trim()) return fail("step_done", "step_done requires a `step_id`.");
					const current = mgr.current();
					const target = current?.steps.find((s) => s.id === input.step_id);
					if (!target) return fail("step_done", `No step with id ${input.step_id} in the current plan.`);

					// PIT_NO_STEP_VERIFY restores the 100% advisory behavior: step_done never
					// executes anything, exactly like before this feature existed.
					const verifyDisabled = isStepVerifyDisabled();
					if (target.verifyCmd && !verifyDisabled) {
						// Validate dependsOn BEFORE spending a verify run — mirrors
						// PlanManager.stepDone's own check so an unmet dependency never pays for
						// a command execution it was always going to reject anyway.
						const statusById = new Map((current?.steps ?? []).map((s) => [s.id, s.status]));
						const unmet = target.dependsOn.filter((d) => statusById.get(d) !== "done");
						if (unmet.length > 0) {
							return fail(
								"step_done",
								`Cannot mark step ${target.id} done: unmet dependsOn: ${unmet.join(", ")}.`,
							);
						}

						const outcome = await runStepVerify(target.verifyCmd, cwd, verifyRunner, signal);
						if (!outcome.ok) {
							// Fail-closed: the step stays exactly as it was — never marked done.
							return {
								content: [{ type: "text" as const, text: outcome.message }],
								isError: true as const,
								details: { op: "step_done" as const, ...snapshot(), error: outcome.message },
							};
						}
					}

					try {
						const step = mgr.stepDone(input.step_id);
						if (!step) return fail("step_done", `No step with id ${input.step_id} in the current plan.`);
						const verifyLine = target.verifyCmd && !verifyDisabled ? `\n\nverify ok: ${target.verifyCmd}` : "";
						return {
							content: [{ type: "text" as const, text: `${mgr.render()}${verifyLine}` }],
							details: { op: "step_done" as const, ...snapshot() },
						};
					} catch (error) {
						if (error instanceof PlanValidationError) return fail("step_done", error.message);
						throw error;
					}
				}
				default: {
					// show — reconstruct the current DAG verbatim (compaction-safe).
					if (mgr.isEmpty()) {
						return {
							content: [{ type: "text" as const, text: "No plan yet. Create one with `plan propose`." }],
							details: { op: "show" as const, version: 0, steps: [] },
						};
					}
					return {
						content: [{ type: "text" as const, text: mgr.render() }],
						details: { op: "show" as const, ...snapshot() },
					};
				}
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const op = typeof args?.op === "string" ? args.op : "";
			text.setText(`${theme.fg("toolTitle", theme.bold("plan"))} ${theme.fg("accent", op)}`);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result, context.showImages).trim();
			// No leading newline: call and result are stacked children of the shell
			// container; a `\n` here would insert a blank line between them.
			text.setText(output ? theme.fg("toolOutput", output) : "");
			return text;
		},
	};
}

export function createPlanTool(cwd: string, options?: PlanToolOptions): AgentTool<typeof planSchema> {
	return wrapToolDefinition(createPlanToolDefinition(cwd, options));
}
