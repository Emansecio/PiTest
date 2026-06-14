import type { JudgeAnalysis, PanelMember, PanelResult } from "./types.ts";

export interface FusionTurnDeps {
	userPrompt: string;
	panel: PanelMember[];
	staggerSameCliMs: number;
	signal?: AbortSignal;
	/** Run one member (cli-runner in prod). */
	runMember: (member: PanelMember) => Promise<PanelResult>;
	/** Structured judge over the surviving results. */
	runJudge: (userPrompt: string, results: PanelResult[]) => Promise<JudgeAnalysis>;
	/** Final writer pass; returns the answer text. */
	writer: (userPrompt: string, results: PanelResult[], analysis: JudgeAnalysis) => Promise<string>;
}

export interface FusionTurnOutcome {
	handled: boolean;
	text: string;
	analysis?: JudgeAnalysis;
	results?: PanelResult[];
}

export const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise<void>((resolve) => {
		if (ms <= 0) return resolve();
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true },
		);
	});

export async function runFusionTurn(deps: FusionTurnDeps): Promise<FusionTurnOutcome> {
	const { panel, staggerSameCliMs, signal } = deps;

	// Fan-out in parallel; stagger a same-CLI second member to dodge correlated throttling.
	const launches = panel.map(async (member, i) => {
		if (i > 0 && panel[i - 1].cli === member.cli) await delay(staggerSameCliMs, signal);
		return deps.runMember(member);
	});
	const results = await Promise.all(launches);

	const survivors = results.filter((r) => r.ok);
	if (survivors.length === 0) return { handled: false, text: "" };

	const analysis = await deps.runJudge(deps.userPrompt, results);
	const text = await deps.writer(deps.userPrompt, results, analysis);
	return { handled: true, text, analysis, results };
}
