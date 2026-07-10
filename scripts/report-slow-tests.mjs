#!/usr/bin/env node
/**
 * Report slowest Vitest files from the latest coding-agent results.json cache.
 *
 * Usage:
 *   node scripts/report-slow-tests.mjs
 *   node scripts/report-slow-tests.mjs --top=30
 *   node scripts/report-slow-tests.mjs --fail-ms=15000
 *
 * Exit 0 by default (warning-only). With --fail-ms=N, exit 1 if any file
 * duration exceeds N milliseconds.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vitestCacheRoot = join(root, "packages/coding-agent/node_modules/.vite/vitest");

function parseArgs(argv) {
	let top = 20;
	let failMs = undefined;
	for (const arg of argv) {
		if (arg.startsWith("--top=")) {
			top = Number.parseInt(arg.slice("--top=".length), 10);
		} else if (arg.startsWith("--fail-ms=")) {
			failMs = Number.parseInt(arg.slice("--fail-ms=".length), 10);
		}
	}
	if (!Number.isFinite(top) || top < 1) top = 20;
	if (failMs !== undefined && (!Number.isFinite(failMs) || failMs < 1)) {
		console.error("report-slow-tests: --fail-ms must be a positive number");
		process.exit(2);
	}
	return { top, failMs };
}

function findLatestResultsJson(dir) {
	if (!existsSync(dir)) return undefined;
	let best;
	let bestMtime = -1;
	for (const name of readdirSync(dir)) {
		const sub = join(dir, name);
		let st;
		try {
			st = statSync(sub);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		const candidate = join(sub, "results.json");
		if (!existsSync(candidate)) continue;
		const mtime = statSync(candidate).mtimeMs;
		if (mtime > bestMtime) {
			bestMtime = mtime;
			best = candidate;
		}
	}
	return best;
}

function loadEntries(path) {
	const raw = JSON.parse(readFileSync(path, "utf8"));
	const results = raw.results;
	if (!Array.isArray(results)) {
		throw new Error(`Unexpected results.json shape at ${path}`);
	}
	return results.map(([file, meta]) => ({
		file: String(file).replace(/^:/, ""),
		duration: Number(meta?.duration) || 0,
		failed: Boolean(meta?.failed),
	}));
}

const { top, failMs } = parseArgs(process.argv.slice(2));
const resultsPath = findLatestResultsJson(vitestCacheRoot);
if (!resultsPath) {
	console.log("report-slow-tests: no vitest results.json found under packages/coding-agent/node_modules/.vite/vitest/");
	process.exit(0);
}

const entries = loadEntries(resultsPath).sort((a, b) => b.duration - a.duration);
const shown = entries.slice(0, top);
const sum = entries.reduce((s, e) => s + e.duration, 0);

console.log(`slow tests (from ${resultsPath.replace(/\\/g, "/")})`);
console.log(`files=${entries.length} sum_cpu_ms=${Math.round(sum)} top=${shown.length}`);
for (const e of shown) {
	const flag = e.failed ? " FAIL" : "";
	console.log(`${String(Math.round(e.duration)).padStart(7)}ms  ${e.file}${flag}`);
}

if (failMs !== undefined) {
	const offenders = entries.filter((e) => e.duration > failMs);
	if (offenders.length > 0) {
		console.error(`\nreport-slow-tests: ${offenders.length} file(s) exceeded ${failMs}ms`);
		process.exit(1);
	}
}
