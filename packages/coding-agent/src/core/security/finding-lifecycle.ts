export type FindingState = "candidate" | "reproduced" | "validated" | "retracted";

interface BaseFindingEvent {
	state: FindingState;
	summary: string;
}

export interface CandidateFindingEvent extends BaseFindingEvent {
	state: "candidate";
	source: string;
}

export interface ReproducedFindingEvent extends BaseFindingEvent {
	state: "reproduced";
	evidenceIds: string[];
}

export interface ValidatedFindingEvent extends BaseFindingEvent {
	state: "validated";
	evidenceIds: string[];
}

export interface RetractedFindingEvent {
	state: "retracted";
	reason: string;
	summary?: string;
}

export type FindingEvent =
	| CandidateFindingEvent
	| ReproducedFindingEvent
	| ValidatedFindingEvent
	| RetractedFindingEvent;

const NEXT_STATE: Readonly<Record<Exclude<FindingState, "retracted">, FindingState>> = {
	candidate: "reproduced",
	reproduced: "validated",
	validated: "validated",
};

export function assertFindingTransition(history: readonly FindingEvent[], next: FindingEvent): void {
	const current = history.at(-1);
	if (!current) {
		if (next.state !== "candidate") throw new Error(`Finding lifecycle must start at candidate, not ${next.state}`);
		return;
	}
	if (current.state === "retracted") throw new Error("A retracted finding is terminal");
	if (next.state === "retracted") return;
	const expected = NEXT_STATE[current.state];
	if (current.state === "validated" || next.state !== expected) {
		throw new Error(`Illegal finding transition: ${current.state} -> ${next.state}`);
	}
}
