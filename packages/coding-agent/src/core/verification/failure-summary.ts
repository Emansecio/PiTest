import { sliceSafe } from "../../utils/surrogate.ts";
import { getCurrentSessionContract } from "../session-contract.ts";
import { summarizeTestRun } from "./test-summary.ts";

const MAX_FAILURE_LINES = 16;
const TAIL_CHARS = 4000;

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
	const hits: string[] = [];
	let matched = 0;
	for (const re of FAILURE_PATTERNS) {
		for (const match of output.matchAll(re)) {
			const line = match[0].trim();
			if (line.length === 0 || seen.has(line)) continue;
			seen.add(line);
			matched++;
			if (hits.length < MAX_FAILURE_LINES) hits.push(line);
		}
	}
	if (hits.length === 0) {
		if (headline) return headline;
		return output.length > TAIL_CHARS ? `…\n${sliceSafe(output, output.length - TAIL_CHARS)}` : output;
	}
	const omitted = matched - hits.length;
	const lines = headline ? [headline, ...hits] : [...hits];
	if (omitted > 0) lines.push(`… (+${omitted} more failing line${omitted === 1 ? "" : "s"})`);
	return lines.join("\n");
}
