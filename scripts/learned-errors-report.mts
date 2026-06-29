/**
 * Cross-session learned-error report.
 *
 * Reads `~/.pit/agent/learned-errors/*.jsonl` (one per session, written by the
 * agent on dispose) and prints:
 *
 *   1. Top recurring fingerprints already covered by a built-in Tier 4 rule
 *      — so you can see which existing rules pay off the most.
 *
 *   2. Top recurring fingerprints with NO matching rule — these are
 *      candidates for a hand-written rule. The report prints a skeleton
 *      `ToolErrorHintRule` per candidate for easy copy-paste.
 *
 *   3. Aggregate stats: distinct sessions, total errors, coverage rate.
 *
 * Run:
 *   npx tsx scripts/learned-errors-report.mts
 *   PIT_LEARNED_ERRORS_DIR=/custom/path npx tsx scripts/learned-errors-report.mts
 */

import {
	type AggregatedLearnedError,
	aggregateLearnedErrors,
	defaultLearnedErrorsDir,
} from "../packages/coding-agent/src/core/learned-error-store.ts";

const dir = process.env.PIT_LEARNED_ERRORS_DIR ?? defaultLearnedErrorsDir();
const aggregated = await aggregateLearnedErrors(dir);

if (aggregated.length === 0) {
	console.log(`No learned-error data at ${dir}.`);
	console.log("Run a few pi sessions that hit tool errors, then re-run this report.");
	process.exit(0);
}

const covered = aggregated.filter((entry) => entry.matchedRuleIds.length > 0);
const uncovered = aggregated.filter((entry) => entry.matchedRuleIds.length === 0);

const totalOccurrences = aggregated.reduce((acc, entry) => acc + entry.totalCount, 0);
const coveredOccurrences = covered.reduce((acc, entry) => acc + entry.totalCount, 0);
const coverageRate = totalOccurrences === 0 ? 0 : coveredOccurrences / totalOccurrences;

console.log(`=== Learned-error report ===`);
console.log(`Source dir:           ${dir}`);
console.log(`Distinct fingerprints: ${aggregated.length}  (${covered.length} covered, ${uncovered.length} uncovered)`);
console.log(`Total occurrences:    ${totalOccurrences}  (${coveredOccurrences} covered)`);
console.log(`Coverage rate:        ${(coverageRate * 100).toFixed(1)}%`);
console.log("");

const TOP_COVERED = 10;
const TOP_UNCOVERED = 15;

if (covered.length > 0) {
	console.log(`=== Top ${Math.min(TOP_COVERED, covered.length)} covered fingerprints (built-in rule already handles) ===`);
	for (const entry of covered.slice(0, TOP_COVERED)) {
		console.log(
			`  [${entry.tool}]  count=${entry.totalCount}  sessions=${entry.sessionCount}  rule=${entry.matchedRuleIds.join(",")}`,
		);
		console.log(`    fingerprint: ${truncate(entry.fingerprint, 100)}`);
	}
	console.log("");
}

if (uncovered.length > 0) {
	console.log(`=== Top ${Math.min(TOP_UNCOVERED, uncovered.length)} uncovered fingerprints (candidates for hand-written rules) ===`);
	for (let i = 0; i < Math.min(TOP_UNCOVERED, uncovered.length); i++) {
		const entry = uncovered[i];
		console.log("");
		console.log(`  Candidate ${i + 1}: [${entry.tool}]  count=${entry.totalCount}  sessions=${entry.sessionCount}`);
		console.log(`    fingerprint: ${truncate(entry.fingerprint, 120)}`);
		console.log(`    sample text: ${truncate(entry.sampleErrorText, 200)}`);
		if (entry.sampleArgs) {
			console.log(`    sample args: ${truncate(entry.sampleArgs, 160)}`);
		}
		console.log("    skeleton:");
		console.log(skeletonFor(entry, i + 1));
	}
	console.log("");
}

console.log(`=== Aggregate metrics ===`);
console.log(`METRIC learned-errors.distinct_fingerprints=${aggregated.length}`);
console.log(`METRIC learned-errors.covered_fingerprints=${covered.length}`);
console.log(`METRIC learned-errors.uncovered_fingerprints=${uncovered.length}`);
console.log(`METRIC learned-errors.total_occurrences=${totalOccurrences}`);
console.log(`METRIC learned-errors.covered_occurrences=${coveredOccurrences}`);
console.log(`METRIC learned-errors.coverage_rate=${coverageRate.toFixed(4)}`);

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\u2026`;
}

function skeletonFor(entry: AggregatedLearnedError, n: number): string {
	const escaped = entry.fingerprint.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");
	return [
		`      {`,
		`        id: "${entry.tool}-pattern-${n}",`,
		`        appliesTo: "${entry.tool}",`,
		`        matcher: ({ errorText }) => /${escaped.slice(0, 60)}/i.test(errorText),`,
		`        hint: () => "TODO: replace with actionable recovery hint",`,
		`      },`,
	].join("\n");
}
