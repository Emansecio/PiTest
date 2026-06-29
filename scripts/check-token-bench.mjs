/**
 * G12 — CI regression gate for context-economy token benches.
 *
 * Runs bench-session-tokens + bench-prompt-size + bench-fusion-tokens in
 * parallel, parses METRIC lines, and compares against
 * scripts/baselines/token-economy.json.
 *
 * Usage: node scripts/check-token-bench.mjs
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const baselinePath = join(here, "baselines", "token-economy.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

const BENCH_SCRIPTS = [
	"scripts/bench-session-tokens.mts",
	"scripts/bench-prompt-size.mts",
	"scripts/bench-fusion-tokens.mts",
];

function runBench(script) {
	return new Promise((resolve, reject) => {
		const child = spawn("node", ["--import", "tsx", script], {
			cwd: repoRoot,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			out += chunk;
		});
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`bench failed: ${script} (exit ${code})\n${out.slice(-4000)}`));
				return;
			}
			resolve(out);
		});
		child.on("error", (err) => {
			reject(err);
		});
	});
}

function parseMetrics(output) {
	const metrics = new Map();
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("METRIC ")) continue;
		const body = trimmed.slice("METRIC ".length);
		const eq = body.lastIndexOf("=");
		if (eq <= 0) continue;
		const key = body.slice(0, eq).trim();
		const raw = body.slice(eq + 1).trim();
		const num = Number(raw);
		metrics.set(key, Number.isFinite(num) ? num : raw);
	}
	return metrics;
}

function checkRule(kind, key, expected, actual, failures) {
	if (actual === undefined) {
		failures.push(`${kind} ${key}: missing METRIC`);
		return;
	}
	if (typeof actual !== "number") {
		failures.push(`${kind} ${key}: non-numeric value ${actual}`);
		return;
	}
	if (kind === "exact" && actual !== expected) {
		failures.push(`exact ${key}: got ${actual}, want ${expected}`);
		return;
	}
	if (kind === "min" && actual < expected) {
		failures.push(`min ${key}: got ${actual}, want >= ${expected}`);
		return;
	}
	if (kind === "max" && actual > expected) {
		failures.push(`max ${key}: got ${actual}, want <= ${expected}`);
	}
}

let benchOutputs;
try {
	benchOutputs = await Promise.all(BENCH_SCRIPTS.map((script) => runBench(script)));
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
}

const metrics = parseMetrics(benchOutputs.join("\n"));

const failures = [];
for (const [kind, rules] of Object.entries(baseline)) {
	if (kind === "version" || kind === "updated" || kind === "comment") continue;
	if (!rules || typeof rules !== "object") continue;
	for (const [key, expected] of Object.entries(rules)) {
		checkRule(kind, key, expected, metrics.get(key), failures);
	}
}

if (failures.length > 0) {
	console.error("token-economy regression gate failed:\n");
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}

console.log(
	`token-economy gate ok (${Object.keys(baseline.exact ?? {}).length} exact, ` +
		`${Object.keys(baseline.min ?? {}).length} min, ${Object.keys(baseline.max ?? {}).length} max)`,
);