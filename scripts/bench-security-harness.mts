import { performance } from "node:perf_hooks";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type FindingValidationInput,
	validateFinding,
} from "../packages/coding-agent/src/core/security/finding-validator.ts";

interface Fixture {
	id: string;
	discoveredAtMs: number;
	pocAtMs: number;
	input: FindingValidationInput;
}

const fixtureDir = join(process.cwd(), "bench", "security", "fixtures");
const fixtures = readdirSync(fixtureDir)
	.filter((name) => name.endsWith(".json"))
	.sort()
	.map((name) => JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as Fixture);

const measured = fixtures.map((fixture) => {
	const started = performance.now();
	const result = validateFinding(fixture.input);
	return {
		id: fixture.id,
		actual: result.valid,
		validationMs: Number((performance.now() - started).toFixed(3)),
		discoveryToPocMs: fixture.pocAtMs - fixture.discoveredAtMs,
	};
});

// Load expectations only after running the validator, keeping the oracle out of
// the evaluated input path.
const oracle = JSON.parse(
	readFileSync(join(process.cwd(), "bench", "security", "oracles", "expected.json"), "utf8"),
) as Record<string, boolean>;

let falsePositives = 0;
let falseNegatives = 0;
for (const result of measured) {
	const expected = oracle[result.id];
	if (expected === undefined) throw new Error(`Missing held-out oracle for ${result.id}`);
	if (result.actual && !expected) falsePositives++;
	if (!result.actual && expected) falseNegatives++;
}

const summary = {
	cases: measured.length,
	falsePositives,
	falseNegatives,
	meanDiscoveryToPocMs:
		measured.reduce((total, result) => total + result.discoveryToPocMs, 0) / Math.max(1, measured.length),
	results: measured,
};
console.log(JSON.stringify(summary, null, 2));
if (falsePositives > 0 || falseNegatives > 0 || measured.length !== Object.keys(oracle).length) process.exitCode = 1;

