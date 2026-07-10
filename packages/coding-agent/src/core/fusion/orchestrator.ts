import { recordDiagnostic } from "@pit/ai";
import { isThrottleError } from "../../modes/interactive/retry-reason.ts";
import { shouldSkipFusionVerify } from "./judge.ts";
import type { JudgeAnalysis, PanelMember, PanelResult, VerificationReport } from "./types.ts";

export interface FusionTurnDeps {
	userPrompt: string;
	panel: PanelMember[];
	staggerSameCliMs: number;
	signal?: AbortSignal;
	/** Run one member (cli-runner in prod). */
	runMember: (member: PanelMember) => Promise<PanelResult>;
	/** Structured judge over the surviving results. */
	runJudge: (userPrompt: string, results: PanelResult[]) => Promise<JudgeAnalysis>;
	/** Optional read-only fact-check of the surviving results against the code, before the
	 * writer synthesizes. Returns undefined when verification is disabled or fails (fail-open). */
	verify?: (
		userPrompt: string,
		results: PanelResult[],
		analysis: JudgeAnalysis,
	) => Promise<VerificationReport | undefined>;
	/** Final writer pass; returns the answer text. */
	writer: (
		userPrompt: string,
		results: PanelResult[],
		analysis: JudgeAnalysis,
		verification?: VerificationReport,
	) => Promise<string>;
}

export interface FusionTurnOutcome {
	handled: boolean;
	text: string;
	analysis?: JudgeAnalysis;
	results?: PanelResult[];
	verification?: VerificationReport;
	/** Set when both members failed after a coordinated throttle retry (§12). */
	degraded?: "both-throttled";
}

/** Short backoff before one coordinated retry when both panel members throttle together. */
export const BOTH_THROTTLED_RETRY_BACKOFF_MS = 1500;

export const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise<void>((resolve) => {
		if (ms <= 0) return resolve();
		const onAbort = () => {
			clearTimeout(t);
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});

const EMPTY_ANALYSIS: JudgeAnalysis = {
	consensus: [],
	contradictions: [],
	partialCoverage: [],
	uniqueInsights: [],
	blindSpots: [],
	unsupportedClaims: [],
};

function allMembersFailedThrottle(results: PanelResult[]): boolean {
	return results.length > 0 && results.every((r) => !r.ok && isThrottleError(r.error));
}

async function launchPanelMembers(deps: FusionTurnDeps): Promise<PanelResult[]> {
	const { panel, staggerSameCliMs, signal } = deps;
	// Fan-out in parallel; stagger any later same-CLI member to dodge correlated throttling.
	const launches = panel.map(async (member, i) => {
		const hasEarlierSameCli = panel.slice(0, i).filter((m) => m.cli === member.cli).length > 0;
		if (hasEarlierSameCli) await delay(staggerSameCliMs, signal);
		// Abort can land during the stagger; don't spawn a subprocess we'd immediately discard.
		if (signal?.aborted) return { member, ok: false, text: "", error: "aborted" };
		return deps.runMember(member);
	});
	return Promise.all(launches);
}

export async function runFusionTurn(deps: FusionTurnDeps): Promise<FusionTurnOutcome> {
	const { signal } = deps;

	let results = await launchPanelMembers(deps);
	let survivors = results.filter((r) => r.ok);

	// §12: one coordinated retry when both members failed with throttle errors.
	if (survivors.length === 0 && allMembersFailedThrottle(results)) {
		recordDiagnostic({
			category: "fusion.both-throttled-retry",
			level: "info",
			source: "fusion.orchestrator",
			context: { note: `backoffMs=${BOTH_THROTTLED_RETRY_BACKOFF_MS}` },
		});
		await delay(BOTH_THROTTLED_RETRY_BACKOFF_MS, signal);
		if (!signal?.aborted) {
			results = await launchPanelMembers(deps);
			survivors = results.filter((r) => r.ok);
		}
	}

	if (survivors.length === 0) {
		return {
			handled: false,
			text: "",
			degraded: allMembersFailedThrottle(results) ? "both-throttled" : undefined,
		};
	}

	// Single survivor: skip the judge (degenerate over [1 real + 1 failed]); the verifier still
	// fact-checks the lone advisor, and the writer synthesizes/streams.
	const judged = survivors.length >= 2;
	const analysis = judged ? await deps.runJudge(deps.userPrompt, results) : EMPTY_ANALYSIS;

	// Verify stage: fact-check unsupported claims against the code (read-only). Skipped when the
	// judge found nothing to fact-check (F2); still runs for a lone survivor (no judge). Fail-open.
	let verification: VerificationReport | undefined;
	if (deps.verify) {
		if (shouldSkipFusionVerify(analysis, judged)) {
			recordDiagnostic({
				category: "fusion.verify-skipped",
				level: "info",
				source: "fusion.orchestrator",
				context: {
					note: `judged=${judged} unsupportedClaims=${analysis.unsupportedClaims.length}`,
				},
			});
		} else {
			verification = await deps.verify(deps.userPrompt, results, analysis);
		}
	}

	const text = await deps.writer(deps.userPrompt, results, analysis, verification);
	return { handled: true, text, analysis: judged ? analysis : undefined, results, verification };
}
