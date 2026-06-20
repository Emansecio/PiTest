/**
 * Compile a test-runner's output into a single compact headline so the CLI shows
 * "✓ 142 passed" / "✗ 3 failed · 142 passed" instead of the full runner dump.
 * Pure + tolerant: returns undefined when the output isn't recognizably a test
 * run, so callers fall back to their existing behaviour. Recognizes vitest, jest,
 * mocha and node:test totals (the schemes pit's check command actually emits).
 */

const ANSI = /\u001B\[[0-9;]*m/g;

export interface TestRunSummary {
	failed: number;
	passed: number;
	skipped: number;
	/** One-line compiled headline, e.g. "✗ 3 failed · 142 passed · 1 skipped". */
	headline: string;
}

function buildHeadline(failed: number, passed: number, skipped: number): TestRunSummary {
	const parts: string[] = [];
	if (failed > 0) parts.push(`${failed} failed`);
	parts.push(`${passed} passed`);
	if (skipped > 0) parts.push(`${skipped} skipped`);
	return { failed, passed, skipped, headline: `${failed > 0 ? "✗" : "✓"} ${parts.join(" · ")}` };
}

function countKeyword(segment: string, keyword: string): number {
	const m = segment.match(new RegExp(`(\\d+)\\s+${keyword}`, "i"));
	return m ? Number.parseInt(m[1], 10) : 0;
}

function firstNumber(text: string, re: RegExp): number | undefined {
	const m = text.match(re);
	return m ? Number.parseInt(m[1], 10) : undefined;
}

/**
 * Extract a compiled summary from raw (possibly ANSI-coloured, possibly tail-
 * truncated) test output. Totals print at the END of a run, so a truncated tail
 * still carries them.
 */
export function summarizeTestRun(rawOutput: string): TestRunSummary | undefined {
	if (!rawOutput) return undefined;
	const text = rawOutput.replace(ANSI, "");

	// vitest ("Tests  3 failed | 142 passed | 2 skipped (147)") and
	// jest ("Tests:   3 failed, 142 passed, 145 total"). "Test Files"/"Test Suites"
	// lines don't start with the literal "Tests", so they're not matched here.
	let testsLine: string | undefined;
	for (const m of text.matchAll(/^\s*Tests:?\s+([^\n]*(?:passed|failed|skipped|todo)[^\n]*)$/gim)) {
		testsLine = m[1];
	}
	if (testsLine) {
		const failed = countKeyword(testsLine, "failed");
		const passed = countKeyword(testsLine, "passed");
		const skipped = countKeyword(testsLine, "skipped") + countKeyword(testsLine, "todo");
		if (failed + passed + skipped > 0) return buildHeadline(failed, passed, skipped);
	}

	// mocha: "142 passing (2s)" / "3 failing" / "1 pending".
	const passing = firstNumber(text, /(\d+)\s+passing\b/i);
	const failing = firstNumber(text, /(\d+)\s+failing\b/i);
	if (passing !== undefined || failing !== undefined) {
		const pending = firstNumber(text, /(\d+)\s+pending\b/i) ?? 0;
		return buildHeadline(failing ?? 0, passing ?? 0, pending);
	}

	// node:test TAP/spec reporter: "# pass 142" / "ℹ pass 142", same for fail/skipped.
	const npass = firstNumber(text, /^[#ℹ\s]*pass\s+(\d+)\s*$/im);
	const nfail = firstNumber(text, /^[#ℹ\s]*fail\s+(\d+)\s*$/im);
	if (npass !== undefined || nfail !== undefined) {
		const nskip = firstNumber(text, /^[#ℹ\s]*skipped\s+(\d+)\s*$/im) ?? 0;
		return buildHeadline(nfail ?? 0, npass ?? 0, nskip);
	}

	return undefined;
}
