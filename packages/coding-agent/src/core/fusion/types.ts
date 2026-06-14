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
}
