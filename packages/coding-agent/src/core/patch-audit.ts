import { isTruthyEnvFlag } from "../utils/env-flags.ts";

export type PatchAuditRisk = "low" | "medium" | "high";

export interface PatchAuditOptions {
	mediumChangedLines?: number;
	highChangedLines?: number;
	highWriteLines?: number;
}

export interface PatchAuditInput {
	toolName: string;
	input: Record<string, unknown>;
	details: unknown;
	isError: boolean;
}

export interface PatchAuditResult {
	risk: PatchAuditRisk;
	toolName: string;
	path: string | undefined;
	addedLines: number;
	removedLines: number;
	changedLines: number;
	reasons: string[];
}

export type PatchAuditDecision =
	| { action: "skip" }
	| {
			action: "append";
			audit: PatchAuditResult;
			message: string;
	  };

/** Line-count measurement of a single patch, before any risk classification. */
export interface PatchMeasurement {
	path: string | undefined;
	addedLines: number;
	removedLines: number;
	changedLines: number;
	/** Non-zero only for a full-file `write` (content lines); 0 for diff/edit patches. */
	writeLines: number;
	/** Unified diff text, when the tool result carried one (cheaply reusable downstream). */
	diff: string | undefined;
}

export const DEFAULT_MEDIUM_CHANGED_LINES = 40;
export const DEFAULT_HIGH_CHANGED_LINES = 120;
export const DEFAULT_HIGH_WRITE_LINES = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProperty(value: Record<string, unknown>, key: string): string | undefined {
	const v = value[key];
	return typeof v === "string" ? v : undefined;
}

function countLogicalLines(text: string): number {
	if (text.length === 0) return 0;
	const parts = text.split("\n");
	return text.endsWith("\n") ? parts.length - 1 : parts.length;
}

function extractPath(input: Record<string, unknown>): string | undefined {
	return (
		stringProperty(input, "path") ??
		stringProperty(input, "file_path") ??
		stringProperty(input, "filepath") ??
		stringProperty(input, "filename") ??
		stringProperty(input, "file")
	);
}

function extractDiff(details: unknown): string | undefined {
	if (!isRecord(details)) return undefined;
	const diff = details.diff;
	return typeof diff === "string" ? diff : undefined;
}

function countChangedDiffLines(diff: string): { addedLines: number; removedLines: number } {
	let addedLines = 0;
	let removedLines = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) addedLines++;
		else if (line.startsWith("-") && !line.startsWith("---")) removedLines++;
	}
	return { addedLines, removedLines };
}

function countEditInputLines(input: Record<string, unknown>): { addedLines: number; removedLines: number } {
	let addedLines = 0;
	let removedLines = 0;

	const edits = input.edits;
	if (Array.isArray(edits)) {
		for (const edit of edits) {
			if (!isRecord(edit)) continue;
			const oldText = stringProperty(edit, "oldText");
			const newText = stringProperty(edit, "newText");
			if (oldText !== undefined) removedLines += countLogicalLines(oldText);
			if (newText !== undefined) addedLines += countLogicalLines(newText);
		}
	}

	const legacyOldText = stringProperty(input, "oldText");
	const legacyNewText = stringProperty(input, "newText");
	if (legacyOldText !== undefined) removedLines += countLogicalLines(legacyOldText);
	if (legacyNewText !== undefined) addedLines += countLogicalLines(legacyNewText);

	return { addedLines, removedLines };
}

function classifyRisk(
	toolName: string,
	changedLines: number,
	writeLines: number,
	options: Required<PatchAuditOptions>,
): { risk: PatchAuditRisk; reasons: string[] } {
	const reasons: string[] = [];
	if (toolName === "write" && writeLines >= options.highWriteLines) {
		reasons.push(`large write (${writeLines} lines)`);
		return { risk: "high", reasons };
	}
	if (changedLines >= options.highChangedLines) {
		reasons.push(`large diff (${changedLines} changed lines)`);
		return { risk: "high", reasons };
	}
	if (changedLines >= options.mediumChangedLines) {
		reasons.push(`non-trivial diff (${changedLines} changed lines)`);
		return { risk: "medium", reasons };
	}
	return { risk: "low", reasons };
}

export function resolvePatchAuditOptions(options: PatchAuditOptions | undefined): Required<PatchAuditOptions> {
	return {
		mediumChangedLines: options?.mediumChangedLines ?? DEFAULT_MEDIUM_CHANGED_LINES,
		highChangedLines: options?.highChangedLines ?? DEFAULT_HIGH_CHANGED_LINES,
		highWriteLines: options?.highWriteLines ?? DEFAULT_HIGH_WRITE_LINES,
	};
}

/**
 * Classify a raw changed-line total against the medium/high thresholds. This is
 * the SAME rubric `classifyRisk` uses for a single patch's diff — extracted so the
 * per-turn aggregator (core/turn-risk.ts) can reuse the exact thresholds and close
 * the documented gap where many small edits never trip `high` individually.
 */
export function classifyChangedLinesRisk(changedLines: number, options?: PatchAuditOptions): PatchAuditRisk {
	const resolved = resolvePatchAuditOptions(options);
	if (changedLines >= resolved.highChangedLines) return "high";
	if (changedLines >= resolved.mediumChangedLines) return "medium";
	return "low";
}

/**
 * Pure line-count measurement of a single write/edit/diff-bearing patch, WITHOUT
 * classifying its risk. Returns `undefined` for the same skip conditions as
 * `auditPatchResult` (errors, previews, non-mutating results). Both the per-patch
 * auditor and the per-turn aggregator build on this so they measure identically.
 */
export function measurePatch(input: PatchAuditInput): PatchMeasurement | undefined {
	if (input.isError) return undefined;
	if (input.input.preview === true) return undefined;

	let addedLines = 0;
	let removedLines = 0;
	let writeLines = 0;

	const diff = extractDiff(input.details);
	if (diff !== undefined) {
		const counted = countChangedDiffLines(diff);
		addedLines = counted.addedLines;
		removedLines = counted.removedLines;
	} else if (input.toolName === "write") {
		const content = stringProperty(input.input, "content");
		if (content === undefined) return undefined;
		writeLines = countLogicalLines(content);
		addedLines = writeLines;
	} else if (input.toolName === "edit") {
		const counted = countEditInputLines(input.input);
		addedLines = counted.addedLines;
		removedLines = counted.removedLines;
	} else {
		return undefined;
	}

	return {
		path: extractPath(input.input),
		addedLines,
		removedLines,
		changedLines: addedLines + removedLines,
		writeLines,
		diff,
	};
}

export function isPatchAuditDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_NO_PATCH_AUDIT);
}

export function auditPatchResult(input: PatchAuditInput, options?: PatchAuditOptions): PatchAuditDecision {
	const measurement = measurePatch(input);
	if (measurement === undefined) return { action: "skip" };

	const resolvedOptions = resolvePatchAuditOptions(options);
	const { risk, reasons } = classifyRisk(
		input.toolName,
		measurement.changedLines,
		measurement.writeLines,
		resolvedOptions,
	);
	if (risk === "low") return { action: "skip" };

	const audit: PatchAuditResult = {
		risk,
		toolName: input.toolName,
		path: measurement.path,
		addedLines: measurement.addedLines,
		removedLines: measurement.removedLines,
		changedLines: measurement.changedLines,
		reasons,
	};

	return {
		action: "append",
		audit,
		message: formatPatchAuditMessage(audit),
	};
}

/**
 * Concrete self-review checklists, scaled by risk. A specific checklist forces a
 * model to walk items it would not generate on its own (the generic one-liner it
 * skims past); kept short (3 / 5 items) so it never drowns the signal in context.
 * Both are model-agnostic — the item set depends on patch shape, not model tier.
 */
export const MEDIUM_RISK_CHECKLIST: readonly string[] = [
	"Every changed line traces to the request — no incidental refactor, reformat, or rename.",
	"No leftovers: dead code, unused imports, debug logging, or stray TODOs.",
	"Re-read the touched area and run the relevant check before reporting done.",
];

export const HIGH_RISK_CHECKLIST: readonly string[] = [
	"Every changed line traces to the request — no incidental refactor, reformat, or rename.",
	"No leftovers: dead code, unused imports, debug logging, or stray TODOs.",
	"Edge cases covered — empty, null, and error paths, not just the happy path.",
	"Public signatures and contracts unchanged, or every call site updated.",
	"Run the relevant verification (check, test, or LSP) before reporting done; never report done while it is red.",
];

export function formatPatchAuditMessage(audit: PatchAuditResult): string {
	const location = audit.path === undefined ? "this change" : audit.path;
	const header = `Patch audit: ${audit.risk}-risk change in ${location} (${audit.changedLines} changed lines: +${audit.addedLines}/-${audit.removedLines}).`;
	const items = audit.risk === "high" ? HIGH_RISK_CHECKLIST : MEDIUM_RISK_CHECKLIST;
	const checklist = items.map((item) => `- [ ] ${item}`).join("\n");
	return `${header} Before declaring the task done, self-review this diff:\n${checklist}`;
}
