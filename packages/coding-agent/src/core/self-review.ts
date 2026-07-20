/**
 * Structured self-review — Band P / P4 (study §4-P4, §5).
 *
 * When a prompt cycle's aggregate patch risk (or any single patch) is HIGH — or
 * MEDIUM while the supervision thermostat sits at `assistido` — this runs ONE
 * read-only review subagent at the end of the turn, BEFORE the verification gate
 * finalizes "done". It mirrors the fusion-verify pattern (agent-session-fusion.ts):
 * a `spawnSubagent` with read-only tools, a strict result schema, and a rubric
 * built from the patch-audit HIGH_RISK_CHECKLIST. HIGH-severity findings are
 * re-injected as a fix prompt that shares the verification gate's attempts budget,
 * and block `goal_complete` (R9) until resolved.
 *
 * This module owns the pure decision/loop logic and the module-level findings
 * registry; the session (core/agent-session.ts) supplies the concrete runner
 * (a spawnSubagent wrapper) and the fix-injection callback. Splitting it this way
 * lets the loop be unit-tested with a stubbed runner — no real subagent spawns.
 *
 * Fase 3 (token-economy layer, see repo-map/graph.ts) widens what the reviewer
 * SEES without touching WHEN it runs: `SelfReviewLoopParams.impactedFiles` — the
 * turn's unreviewed import-graph dependents (impact-extension.ts's registry) —
 * is threaded into `buildSelfReviewPrompt` as extra read-only context ("these
 * files import what changed"), capped and additive; absent/empty renders the
 * exact prompt this module always has.
 *
 * Fail-open everywhere: any runner error/timeout degrades to "no findings" (with a
 * diagnostic), never blocking the turn. Kill-switch: `PIT_NO_SELF_REVIEW=1`.
 */

import { recordDiagnostic } from "@pit/ai";
import { type Static, Type } from "typebox";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import { HIGH_RISK_CHECKLIST } from "./patch-audit.ts";
import type { SupervisionLevel } from "./supervision-thermostat.ts";
import type { TurnRiskTotals } from "./turn-risk.ts";

export const SELF_REVIEW_SCHEMA = Type.Object(
	{
		findings: Type.Array(
			Type.Object(
				{
					claim: Type.String({ description: "One concrete problem you found in the diff." }),
					severity: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
						description:
							"high = a real bug / broken contract / unhandled edge that must be fixed before done; medium = likely defect worth fixing; low = minor.",
					}),
					file: Type.String({ description: "Path of the touched file the problem is in." }),
					evidence: Type.String({
						description: "The specific code / line the claim rests on. Never speculate without evidence.",
					}),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export type SelfReviewResult = Static<typeof SELF_REVIEW_SCHEMA>;
export type SelfReviewFinding = SelfReviewResult["findings"][number];

/** What the session's runner needs to spawn the review subagent. */
export interface SelfReviewRunnerArgs {
	prompt: string;
	systemPrompt: string;
	totals: TurnRiskTotals;
}

/**
 * Runs one review pass and returns its parsed findings. The session implements
 * this by wrapping `spawnSubagent`; tests inject a stub. It MAY throw (schema
 * mismatch, timeout, abort) — the loop treats a throw as fail-open.
 */
export type SelfReviewRunner = (args: SelfReviewRunnerArgs) => Promise<SelfReviewResult>;

export function isSelfReviewDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_NO_SELF_REVIEW);
}

/**
 * Hard timeout for one review subagent pass. Bounded well under a typical check
 * command so the review never dominates end-of-turn latency; a timeout is
 * fail-open (no findings). Matches the "poucos k tokens / short pass" budget in
 * the study (§4-P4).
 */
export const SELF_REVIEW_TIMEOUT_MS = 90_000;

/** Why the review would (not) run — also the trigger-matrix contract for tests. */
export type SelfReviewTriggerReason = "high" | "medium-assistido" | "none";

/**
 * Decide whether the cycle warrants a real review, per the §5 dosing table:
 * HIGH (aggregate OR any single patch) reviews at EVERY thermostat level; MEDIUM
 * reviews ONLY at `assistido`. An undefined level is treated as `padrao` (so it
 * does NOT pull in the medium tier). Zero mutations never review.
 */
export function selfReviewTriggerReason(
	totals: TurnRiskTotals,
	level: SupervisionLevel | undefined,
): SelfReviewTriggerReason {
	if (totals.mutations <= 0) return "none";
	if (totals.aggregateRisk === "high" || totals.maxPatchRisk === "high") return "high";
	const anyMedium = totals.aggregateRisk === "medium" || totals.maxPatchRisk === "medium";
	if (anyMedium && level === "assistido") return "medium-assistido";
	return "none";
}

export function shouldRunSelfReview(totals: TurnRiskTotals, level: SupervisionLevel | undefined): boolean {
	return selfReviewTriggerReason(totals, level) !== "none";
}

/** True when any finding is high-severity (the ones that block "done"). */
export function highFindings(findings: readonly SelfReviewFinding[]): SelfReviewFinding[] {
	return findings.filter((f) => f.severity === "high");
}

// ---------------------------------------------------------------------------
// Prompt construction — the diff summary + rubric fed to the review subagent.
// ---------------------------------------------------------------------------

export const SELF_REVIEW_SYSTEM_PROMPT = [
	"You are a strict, read-only code reviewer. A turn just made a high-risk change and you must catch defects the author cannot see.",
	"",
	"Review ONLY the supplied diff summary and the touched files (open them with read/grep/find/ls as needed). Do NOT review anything outside the touched files.",
	"",
	"Judge the change against this rubric:",
	...HIGH_RISK_CHECKLIST.map((item) => `- ${item}`),
	"",
	"Report ONLY real problems, each backed by concrete evidence (the offending code / line). If the change is clean, return an EMPTY findings array — never invent problems to look thorough.",
	"Do NOT report style nits, formatting, naming preferences, or subjective taste. A finding is `high` only when it is a genuine bug, a broken contract, or an unhandled edge case that must be fixed before the work can be called done.",
].join("\n");

/**
 * Cap on `impactedFiles` paths embedded in the review prompt (Fase 3, graph
 * escopo expandido). A review subagent gets a short read-only context list,
 * not a second worklist — 10 keeps it a hint, not a review burden.
 */
const IMPACTED_FILES_PROMPT_CAP = 10;

/**
 * Build the review subagent's user prompt from the cycle's touched files +
 * diffs, plus (Fase 3) an optional read-only list of import-graph dependents
 * impacted by the change but NOT themselves edited this turn — "these files
 * import what changed; check the change doesn't break how they use it".
 * Omitted entirely when `impactedFiles` is absent/empty, so the prompt stays
 * byte-identical to the pre-Fase-3 shape in that case (fail-open by construction:
 * an empty impact registry — the common case — never touches this function's
 * existing output).
 */
export function buildSelfReviewPrompt(totals: TurnRiskTotals, impactedFiles?: readonly string[]): string {
	const lines: string[] = [
		`This turn modified ${totals.touchedFiles.length} file(s), ${totals.changedLines} changed lines total (aggregate risk: ${totals.aggregateRisk}).`,
		"",
		"Touched files (path — changed lines):",
	];
	for (const file of totals.touchedFiles) {
		lines.push(`- ${file.path} — ${file.changedLines} changed lines`);
	}
	const withDiffs = totals.touchedFiles.filter((f) => f.diff);
	if (withDiffs.length > 0) {
		lines.push("", "Diffs (where available; read the files directly for the rest):");
		for (const file of withDiffs) {
			lines.push("", `### ${file.path}`, "```diff", file.diff ?? "", "```");
		}
	} else {
		lines.push("", "No diffs were captured — read the touched files directly to review the change.");
	}
	if (impactedFiles && impactedFiles.length > 0) {
		lines.push(
			"",
			"Files that import what changed (not edited this turn — read-only context, per the persisted import graph): these files import what changed; check the change doesn't break how they use it:",
		);
		for (const path of impactedFiles.slice(0, IMPACTED_FILES_PROMPT_CAP)) {
			lines.push(`- ${path}`);
		}
	}
	lines.push("", "Return your findings as the schema requires. Empty findings when the change is clean.");
	return lines.join("\n");
}

/**
 * Continuation prompt re-injecting unresolved HIGH findings, shaped like
 * `verificationFixPrompt`: it names the concrete problems and tells the model to
 * fix the cause before reporting done. A sibling of the verification fix prompt so
 * the two share the same voice and the same attempts budget.
 */
export function selfReviewFixPrompt(findings: readonly SelfReviewFinding[]): string {
	const lines = [
		"The change isn't verified yet — a structured self-review of this turn's diff found high-severity problems:",
		"",
	];
	for (const f of findings) {
		lines.push(`- [${f.file}] ${f.claim}`, `  evidence: ${f.evidence}`);
	}
	lines.push(
		"",
		"Fix the underlying cause of each and keep going; don't report the work done until these are resolved. If a finding is a false positive, say so explicitly with the reason instead of forcing a change.",
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Module-level findings registry, mirroring setCurrentVerificationProbe. The
// active session publishes the latest unresolved HIGH findings so goal_complete
// can refuse completion (R9) without per-call plumbing.
// ---------------------------------------------------------------------------

let currentSelfReviewFindings: SelfReviewFinding[] = [];

export function setCurrentSelfReviewFindings(findings: readonly SelfReviewFinding[]): void {
	currentSelfReviewFindings = [...findings];
}

export function getCurrentSelfReviewFindings(): readonly SelfReviewFinding[] {
	return currentSelfReviewFindings;
}

export function clearCurrentSelfReviewFindings(): void {
	currentSelfReviewFindings = [];
}

// ---------------------------------------------------------------------------
// The review loop — trigger, run, re-inject, all bounded by a SHARED budget.
// ---------------------------------------------------------------------------

export interface SelfReviewLoopParams {
	totals: TurnRiskTotals;
	level: SupervisionLevel | undefined;
	runner: SelfReviewRunner;
	/** Combined verification + review fix budget for the cycle. */
	maxAttempts: number;
	/** Fixes the verification check phase already consumed this cycle. */
	fixesAlreadyUsed: number;
	/** Re-inject a fix prompt as a continuation turn (session._promptOnce). */
	injectFix: (prompt: string) => Promise<void>;
	/** Optional abort probe — stops the loop between passes. */
	isAborted?: () => boolean;
	env?: NodeJS.ProcessEnv;
	/**
	 * Fase 3: repo-relative paths of import-graph dependents impacted by this
	 * turn's edits but not themselves touched — read-only context handed to the
	 * reviewer (see `buildSelfReviewPrompt`), capped at
	 * {@link IMPACTED_FILES_PROMPT_CAP}. Absent/empty is the fail-open default:
	 * the prompt renders exactly as it did before this field existed.
	 */
	impactedFiles?: string[];
}

export interface SelfReviewLoopResult {
	/** True when a review actually ran (trigger fired, not killed/zero-mutation). */
	ran: boolean;
	/** Total combined fixes consumed (includes `fixesAlreadyUsed`). */
	fixesUsed: number;
	/** HIGH findings still unresolved when the loop ended (budget/abort). Empty = clean. */
	unresolvedHigh: SelfReviewFinding[];
	/** How many review passes executed. */
	reviews: number;
}

/**
 * Run the self-review, re-injecting HIGH findings and re-reviewing until they clear
 * or the SHARED attempts budget is spent. Publishes unresolved HIGH findings to the
 * module registry (for goal_complete R9) and clears it once the diff reviews clean.
 * Fail-open: a runner throw ends the loop with no findings.
 */
export async function runSelfReviewLoop(params: SelfReviewLoopParams): Promise<SelfReviewLoopResult> {
	const { totals, level, runner, maxAttempts, injectFix } = params;
	const env = params.env ?? process.env;
	let fixesUsed = params.fixesAlreadyUsed;

	if (isSelfReviewDisabled(env)) return { ran: false, fixesUsed, unresolvedHigh: [], reviews: 0 };
	if (!shouldRunSelfReview(totals, level)) return { ran: false, fixesUsed, unresolvedHigh: [], reviews: 0 };

	const args: SelfReviewRunnerArgs = {
		prompt: buildSelfReviewPrompt(totals, params.impactedFiles),
		systemPrompt: SELF_REVIEW_SYSTEM_PROMPT,
		totals,
	};

	let reviews = 0;
	for (;;) {
		if (params.isAborted?.()) {
			clearCurrentSelfReviewFindings();
			return { ran: reviews > 0, fixesUsed, unresolvedHigh: [], reviews };
		}

		let result: SelfReviewResult;
		try {
			result = await runner(args);
		} catch (err) {
			// Fail-open: never let a review error/timeout block the turn.
			const note = err instanceof Error ? err.message : String(err);
			recordDiagnostic({
				category: "quality.self-review",
				level: "warn",
				source: "self-review",
				context: { ruleId: "review-fail-open", note: `fail-open: ${note.slice(0, 160)}` },
			});
			clearCurrentSelfReviewFindings();
			return { ran: true, fixesUsed, unresolvedHigh: [], reviews };
		}

		reviews++;
		const findings = result?.findings ?? [];
		const high = highFindings(findings);
		const medium = findings.filter((f) => f.severity === "medium").length;
		recordDiagnostic({
			category: "quality.self-review",
			level: high.length > 0 ? "warn" : "info",
			source: "self-review",
			context: {
				ruleId: "review-ran",
				note: `high=${high.length} medium=${medium} low=${findings.length - high.length - medium} files=${totals.touchedFiles.length} pass=${reviews}`,
			},
		});

		if (high.length === 0) {
			clearCurrentSelfReviewFindings();
			return { ran: true, fixesUsed, unresolvedHigh: [], reviews };
		}

		// Register unresolved HIGH findings so goal_complete (R9) blocks completion.
		setCurrentSelfReviewFindings(high);

		if (fixesUsed >= maxAttempts) {
			// Combined verification + review budget exhausted; leave the findings
			// registered so the completion gate still refuses. No further re-inject.
			return { ran: true, fixesUsed, unresolvedHigh: high, reviews };
		}

		fixesUsed++;
		await injectFix(selfReviewFixPrompt(high));
		// Loop: re-review to confirm the fix actually resolved the findings.
	}
}
