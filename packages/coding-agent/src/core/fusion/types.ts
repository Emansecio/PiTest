export type Orchestration = "solo" | "fusion";
export type FusionCli = "codex" | "claude";

export interface PanelMember {
	cli: FusionCli;
	model: string;
}

export interface PanelResult {
	member: PanelMember;
	ok: boolean;
	text: string;
	error?: string;
}

export interface JudgeAnalysis {
	consensus: string[];
	contradictions: string[];
	partialCoverage: string[];
	uniqueInsights: string[];
	blindSpots: string[];
	/** Concrete, checkable claims that look unsupported or only one member made — the
	 * verifier fact-checks these against the code first. */
	unsupportedClaims: string[];
}

export type VerificationVerdict = "confirmed" | "refuted" | "unverified";

/** One fact-checked claim: the verifier ran read-only tools against the actual code. */
export interface VerificationFinding {
	claim: string;
	verdict: VerificationVerdict;
	/** Evidence for the verdict (e.g. "foo.ts:42 defines bar()"), or why it couldn't be confirmed. */
	evidence: string;
}

/** Output of the verify stage — the writer uses it to correct/drop/hedge claims. */
export interface VerificationReport {
	findings: VerificationFinding[];
}

export interface FusionSummaryMember {
	cli: string;
	model: string;
	ok: boolean;
	elapsedMs: number;
	chars: number;
	error?: string;
}

export interface FusionSummaryJudge {
	consensus: number;
	contradictions: number;
	partial: number;
	unique: number;
	blindSpots: number;
}

export interface FusionSummarySynthesisItem {
	kind: "consensus" | "contradiction" | "partial" | "unique" | "blind-spot";
	text: string;
}

export interface FusionSummaryVerification {
	confirmed: number;
	refuted: number;
	unverified: number;
}

export interface FusionSummaryData {
	members: FusionSummaryMember[];
	judge?: FusionSummaryJudge;
	degraded: "none" | "solo-synth" | "both-failed";
	synthId: string;
	synthesis?: FusionSummarySynthesisItem[];
	/** Present when the verify stage ran — counts by verdict for the summary line. */
	verification?: FusionSummaryVerification;
}
