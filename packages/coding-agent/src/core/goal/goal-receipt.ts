import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { GoalContract } from "./goal-contract.ts";

export type GoalEvidenceKind = "changed-file" | "deleted-file" | "referenced-file" | "attested";
export interface GoalEvidenceReceipt {
	kind: GoalEvidenceKind;
	ref?: string;
	note?: string;
}
export interface GoalCriterionReceipt {
	id: string;
	text: string;
	outcome: string;
	evidence: GoalEvidenceReceipt[];
	grounding: "observed" | "attested";
}
export interface GoalGateReceipt {
	id: string;
	label: string;
	source: string;
	status: "passed";
	cached: boolean;
	durationMs?: number;
}
export interface GoalCompletionReceipt {
	version: 1;
	goalId: string;
	objective: string;
	contractRevision: number;
	criteria: GoalCriterionReceipt[];
	mutations: { revision: number; paths: string[]; attribution: "known" | "unknown" | "not_applicable" };
	verification: {
		mechanism: "goal-gates" | "legacy-probe" | "none";
		status: "passed" | "inapplicable";
		reason?: string;
		gates: GoalGateReceipt[];
	};
	safeguards: {
		pendingVerificationChecks: "clear";
		selfReview: "passed" | "not_applicable" | "waived";
		impactReview: "passed" | "not_applicable" | "waived";
	};
	usage: { tokens: number; iterations: number; activeMs: number };
	completedAt: number;
}
export type GoalCompletionReceiptDraft = Omit<GoalCompletionReceipt, "usage" | "completedAt">;

export type GoalEvidenceInput = { kind: "path"; path: string; note?: string } | { kind: "claim"; note: string };
export interface GoalCompleteCriterionInput {
	id: string;
	outcome: string;
	evidence: GoalEvidenceInput[];
}
export interface EvidenceValidation {
	valid: boolean;
	errors: string[];
	criteria: GoalCriterionReceipt[];
}
export const MAX_GOAL_RECEIPT_BYTES = 24 * 1024;
const MAX_OUTCOME = 600,
	MAX_NOTE = 400,
	MAX_REFS = 6;

function contained(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function inside(cwd: string, candidate: string): boolean {
	try {
		const lexicalRoot = resolve(cwd);
		const lexicalTarget = resolve(lexicalRoot, candidate);
		if (!contained(lexicalRoot, lexicalTarget)) return false;
		const realRoot = realpathSync(lexicalRoot);
		let existing = lexicalTarget;
		while (!existsSync(existing)) {
			const parent = dirname(existing);
			if (parent === existing) return false;
			existing = parent;
		}
		return contained(realRoot, realpathSync(existing));
	} catch {
		return false;
	}
}

function normalizePath(path: string): string {
	return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function comparisonKey(path: string): string {
	const normalized = normalizePath(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function validateGoalEvidence(
	contract: GoalContract,
	input: GoalCompleteCriterionInput[] | undefined,
	cwd: string,
	mutatedPaths: readonly string[] = [],
): EvidenceValidation {
	const errors: string[] = [],
		criteria: GoalCriterionReceipt[] = [],
		byId = new Map(input?.map((item) => [item.id, item]) ?? []);
	if (!input)
		return {
			valid: false,
			errors: ["criteria is required; provide one entry for each contract criterion"],
			criteria,
		};
	if (input.length !== contract.criteria.length)
		errors.push("criteria must contain each contract criterion exactly once");
	const mutationSet = new Set(mutatedPaths.map(comparisonKey));
	for (const criterion of contract.criteria) {
		const item = byId.get(criterion.id);
		if (!item) {
			errors.push(`missing criterion ${criterion.id}`);
			continue;
		}
		if (input.filter((entry) => entry.id === criterion.id).length !== 1)
			errors.push(`duplicate criterion ${criterion.id}`);
		const outcome = item.outcome.trim();
		if (!outcome || outcome.length > MAX_OUTCOME) errors.push(`invalid outcome for ${criterion.id}`);
		if (!item.evidence.length || item.evidence.length > MAX_REFS)
			errors.push(`criterion ${criterion.id} must have 1-${MAX_REFS} evidence references`);
		const evidence: GoalEvidenceReceipt[] = [];
		let observed = false;
		for (const ref of item.evidence) {
			if (ref.kind === "claim") {
				const note = ref.note.trim();
				if (!note || note.length > MAX_NOTE) errors.push(`invalid claim for ${criterion.id}`);
				else evidence.push({ kind: "attested", note });
				continue;
			}
			const path = normalizePath(ref.path),
				note = ref.note?.trim();
			if (!path || (note && note.length > MAX_NOTE) || !inside(cwd, path)) {
				errors.push(`invalid path evidence for ${criterion.id}: ${path || "empty"}`);
				continue;
			}
			const changed = mutationSet.has(comparisonKey(path)),
				absolute = resolve(cwd, path);
			if (existsSync(absolute)) {
				let isFile = false;
				try {
					isFile = lstatSync(absolute).isFile();
				} catch {
					// The path changed between validation and inspection; reject it below.
				}
				if (!isFile) {
					errors.push(`path evidence is not a file for ${criterion.id}: ${path}`);
					continue;
				}
				observed = true;
				evidence.push({ kind: changed ? "changed-file" : "referenced-file", ref: path, ...(note ? { note } : {}) });
			} else if (changed) {
				observed = true;
				evidence.push({ kind: "deleted-file", ref: path, ...(note ? { note } : {}) });
			} else errors.push(`path evidence does not exist for ${criterion.id}: ${path}`);
		}
		criteria.push({
			id: criterion.id,
			text: criterion.text,
			outcome,
			evidence,
			grounding: observed ? "observed" : "attested",
		});
	}
	for (const item of input)
		if (!contract.criteria.some((criterion) => criterion.id === item.id)) errors.push(`unknown criterion ${item.id}`);
	if (
		mutatedPaths.length > 0 &&
		mutatedPaths.some((path) => path) &&
		!mutatedPaths.some((path) =>
			criteria.some((criterion) =>
				criterion.evidence.some((evidence) => evidence.ref && comparisonKey(evidence.ref) === comparisonKey(path)),
			),
		)
	)
		errors.push("mutated goal must cite at least one changed or deleted path");
	return { valid: errors.length === 0, errors, criteria };
}

export function receiptPayloadSize(receipt: GoalCompletionReceipt): number {
	return Buffer.byteLength(JSON.stringify(receipt), "utf8");
}
