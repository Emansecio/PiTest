import { sliceSafe } from "../../utils/surrogate.ts";
import { getCurrentSessionContract } from "../session-contract.ts";
import { summarizeTestRun } from "./test-summary.ts";

const MAX_FAILURE_LINES = 16;
/** Small head sample kept when capping the failure lines (rest is tail-biased). */
const HEAD_FAILURE_LINES = 3;
const TAIL_CHARS = 4000;
/** Head slice kept when char-clamping unrecognized output (~20%; tail keeps the rest). */
const HEAD_CHARS = Math.floor(TAIL_CHARS * 0.2);

// Ordered so the most specific/diagnostic patterns win the line cap first.
const FAILURE_PATTERNS: RegExp[] = [
	/^.*\(\d+,\d+\):\s*error\s+TS\d+:.*$/gm, // tsc
	/^.*:\d+:\d+\s+(?:error|lint)\b.*$/gim, // file:line:col error (biome/eslint-ish)
	/^\s*[●✗×]\s+.*$/gm, // vitest/jest failure headers
	/^\s*FAIL\b.*$/gm, // FAIL lines
	/^.*\b(?:Error|AssertionError|TypeError|ReferenceError):\s.*$/gm, // thrown errors
];

/**
 * Extract the load-bearing failure lines from a check command's combined
 * stdout+stderr, dropping PASS/progress noise. Falls back to the last-4000-chars
 * tail (the previous behaviour) when nothing matches, so the gate never loses
 * signal on an unrecognized toolchain.
 */
export function summarizeCheckFailure(output: string, _command: string): string {
	// Band P / P5 (conventions contract): every check failure in the harness flows
	// through this one summarizer, so it is the single choke-point to distill the
	// violated *rule* into a session constraint — without touching agent-session.ts
	// (owned elsewhere). Fail-open and side-effect-only: it never changes the
	// returned summary, no-ops when no session contract is registered (e.g. unit
	// tests of this function), and dedupes an identical output internally.
	try {
		getCurrentSessionContract()?.ingestCheckFailure(output);
	} catch {
		// A contract-extraction fault must never break failure summarization.
	}
	const headline = summarizeTestRun(output)?.headline;
	const seen = new Set<string>();
	// Collect every unique failure line WITH its position in the output so the cap
	// can preserve the TAIL. A long test run prints its failure summary and the
	// last (often most diagnostic) failures at the END — exactly the part a
	// head-biased "first N lines" cap dropped. We keep a small head sample for
	// early context plus a dominant tail.
	const hits: Array<{ line: string; index: number }> = [];
	for (const re of FAILURE_PATTERNS) {
		for (const match of output.matchAll(re)) {
			const line = match[0].trim();
			if (line.length === 0 || seen.has(line)) continue;
			seen.add(line);
			hits.push({ line, index: match.index ?? 0 });
		}
	}
	if (hits.length === 0) {
		if (headline) return headline;
		return clampTailBiased(output);
	}
	// Patterns are collected by priority, not position; re-order by position so the
	// head/tail split reflects where the failures actually appear in the output.
	hits.sort((a, b) => a.index - b.index);
	let selected: string[];
	if (hits.length <= MAX_FAILURE_LINES) {
		selected = hits.map((h) => h.line);
	} else {
		const omitted = hits.length - MAX_FAILURE_LINES;
		const head = hits.slice(0, HEAD_FAILURE_LINES).map((h) => h.line);
		const tail = hits.slice(hits.length - (MAX_FAILURE_LINES - HEAD_FAILURE_LINES)).map((h) => h.line);
		selected = [...head, `… (+${omitted} more failing line${omitted === 1 ? "" : "s"} omitted)`, ...tail];
	}
	const lines = headline ? [headline, ...selected] : selected;
	return lines.join("\n");
}

/**
 * Char-clamp unrecognized output head+tail with a dominant tail: keep a small
 * head slice for early context (the command banner / first errors) and a larger
 * tail slice (where a test runner prints its failure summary), joined by an
 * explicit truncation marker. Total retained size stays within {@link TAIL_CHARS}.
 * Returns the input unchanged when it already fits.
 */
function clampTailBiased(output: string): string {
	if (output.length <= TAIL_CHARS) return output;
	const head = sliceSafe(output, 0, HEAD_CHARS);
	const tail = sliceSafe(output, output.length - (TAIL_CHARS - HEAD_CHARS));
	const truncated = output.length - head.length - tail.length;
	return `${head}\n[... ${truncated} chars truncated ...]\n${tail}`;
}
