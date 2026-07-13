import type { FindingState } from "./finding-lifecycle.ts";

export interface FindingValidationInput {
	currentState: FindingState;
	marker: { value: string; baselineBody: string; controlBody: string; mutationBody: string };
	bodies: { baseline: string; control: string; mutation: string };
	reproduction: { attempts: boolean[] };
	timing?: {
		claimed: boolean;
		interleaved: boolean;
		baselineMs: number[];
		controlMs: number[];
		mutationMs: number[];
	};
	chain?: {
		required: boolean;
		complete: boolean;
		steps: Array<{ name: string; evidenceIds: string[] }>;
	};
}

export interface ValidationCheck {
	name: "lifecycle" | "marker" | "body_diff" | "clean_reproduction" | "timing" | "chain";
	passed: boolean;
	reason: string;
}

export interface FindingValidationResult {
	valid: boolean;
	nextState: FindingState;
	checks: ValidationCheck[];
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, child]) => [key, stableValue(child)]),
		);
	}
	return value;
}

export function canonicalizeBody(body: string): string {
	const trimmed = body.trim();
	try {
		return JSON.stringify(stableValue(JSON.parse(trimmed)));
	} catch {
		return trimmed.replace(/\r\n/g, "\n");
	}
}

function occurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	for (let offset = 0; ; ) {
		const found = haystack.indexOf(needle, offset);
		if (found === -1) return count;
		count++;
		offset = found + needle.length;
	}
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

function mad(values: readonly number[]): number {
	const center = median(values);
	return median(values.map((value) => Math.abs(value - center)));
}

export function validateFinding(input: FindingValidationInput): FindingValidationResult {
	const markerMutationCount = occurrences(input.marker.mutationBody, input.marker.value);
	const markerPassed =
		input.marker.value.length >= 8 &&
		occurrences(input.marker.baselineBody, input.marker.value) === 0 &&
		occurrences(input.marker.controlBody, input.marker.value) === 0 &&
		markerMutationCount > 0;
	const baseline = canonicalizeBody(input.bodies.baseline);
	const control = canonicalizeBody(input.bodies.control);
	const mutation = canonicalizeBody(input.bodies.mutation);
	const reproductionPassed = input.reproduction.attempts.length >= 2 && input.reproduction.attempts.every(Boolean);

	let timingPassed = true;
	let timingReason = "No timing claim required";
	if (input.timing?.claimed) {
		const enoughSamples =
			input.timing.baselineMs.length >= 5 &&
			input.timing.controlMs.length >= 5 &&
			input.timing.mutationMs.length >= 5;
		const controlMedian = Math.max(median(input.timing.baselineMs), median(input.timing.controlMs));
		const effect = median(input.timing.mutationMs) - controlMedian;
		const jitter = Math.max(mad(input.timing.baselineMs), mad(input.timing.controlMs), mad(input.timing.mutationMs));
		timingPassed = input.timing.interleaved && enoughSamples && effect > Math.max(100, jitter * 3);
		timingReason = timingPassed
			? `Median effect ${effect.toFixed(1)}ms exceeds jitter threshold`
			: "Timing evidence needs interleaving, five samples per arm, and an effect above robust jitter";
	}

	const chainPassed =
		!input.chain?.required ||
		(input.chain.complete &&
			input.chain.steps.length >= 2 &&
			input.chain.steps.every((step) => step.name.trim().length > 0 && step.evidenceIds.length > 0));
	const checks: ValidationCheck[] = [
		{
			name: "lifecycle",
			passed: input.currentState === "reproduced",
			reason:
				input.currentState === "reproduced"
					? "Finding was cleanly reproduced"
					: "Finding must be reproduced before validation",
		},
		{
			name: "marker",
			passed: markerPassed,
			reason: markerPassed
				? "Unique marker appears only in mutation"
				: "Marker is absent, too short, or present in a control",
		},
		{
			name: "body_diff",
			passed: mutation !== baseline && mutation !== control,
			reason:
				mutation !== baseline && mutation !== control
					? "Mutation body differs from baseline and control"
					: "Status-only or control-equivalent changes are not vulnerability evidence",
		},
		{
			name: "clean_reproduction",
			passed: reproductionPassed,
			reason: reproductionPassed
				? "All clean reproduction attempts succeeded"
				: "At least two clean successful attempts are required",
		},
		{ name: "timing", passed: timingPassed, reason: timingReason },
		{
			name: "chain",
			passed: chainPassed,
			reason: chainPassed ? "Required chain is complete" : "Every required chain step needs evidence",
		},
	];
	const valid = checks.every((check) => check.passed);
	return { valid, nextState: valid ? "validated" : input.currentState, checks };
}
