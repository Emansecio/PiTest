const MAX_FAILURE_LINES = 40;
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
	const seen = new Set<string>();
	const hits: string[] = [];
	for (const re of FAILURE_PATTERNS) {
		for (const match of output.matchAll(re)) {
			const line = match[0].trim();
			if (line.length > 0 && !seen.has(line)) {
				seen.add(line);
				hits.push(line);
			}
			if (hits.length >= MAX_FAILURE_LINES) break;
		}
		if (hits.length >= MAX_FAILURE_LINES) break;
	}
	if (hits.length === 0) {
		return output.length > TAIL_CHARS ? `…\n${output.slice(-TAIL_CHARS)}` : output;
	}
	return hits.join("\n");
}
