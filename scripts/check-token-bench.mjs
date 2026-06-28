/**
 * G12 — CI regression gate for context-economy token benches.
 *
 * Runs bench-session-tokens + bench-prompt-size, parses METRIC lines, and
 * compares against scripts/baselines/token-economy.json.
 *
 * Usage: node scripts/check-token-bench.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(here, "baselines", "token-economy.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

function runBench(script) {
	const r = spawnSync("npx", ["tsx", script], {
		cwd: join(here, ".."),
		encoding: "utf8",
		shell: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	if (r.status !== 0) {
		console.error(`bench failed: ${script} (exit ${r.status})`);
		console.error(out.slice(-4000));
		process.exit(1);
	}
	return out;
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

const sessionOut = runBench("scripts/bench-session-tokens.mts");
const promptOut = runBench("scripts/bench-prompt-size.mts");
const fusionOut = runBench("scripts/bench-fusion-tokens.mts");
const metrics = parseMetrics(`${sessionOut}\n${promptOut}\n${fusionOut}`);

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