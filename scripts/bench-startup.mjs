#!/usr/bin/env node
/**
 * Bench: run `pit --help` with PIT_TIMING=1 N times, sum extension load
 * times from stderr, print metric for autoresearch.
 *
 * Output: METRIC total_extension_load_ms=<best of N>
 *
 * Default N=3, pass --n=5 to override. Uses bin/pit which spawns tsx.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const N = Number(process.argv.find((a) => a.startsWith("--n="))?.slice(4) ?? 3);
const FULL = process.argv.includes("--full");

// Invoke node + the tsx loader directly (same pipeline as bin/pit post-launcher
// rework) instead of the tsx.cmd shim, which needed shell:true on Windows and
// added 50-100ms of cmd.exe noise per run to the measurement.
const tsxLoaderUrl = pathToFileURL(join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const cli = join(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts");

const re = /Loaded extension .+? in (\d+)ms/g;

const totals = [];
const wallTimes = [];
const counts = [];
for (let i = 0; i < N; i++) {
	const t0 = performance.now();
	const r = spawnSync(process.execPath, ["--import", tsxLoaderUrl, cli, "--help"], {
		cwd: REPO_ROOT,
		// PIT_NO_HELP_CACHE: the --help fast path skips extension loading entirely,
		// which would zero the extension-load metric this bench exists to measure.
		env: { ...process.env, PIT_TIMING: "1", PIT_NO_HELP_CACHE: "1" },
		encoding: "utf8",
		shell: false,
	});
	const wall = performance.now() - t0;
	if (r.status !== 0) {
		console.error("pit --help failed", r.status, r.stderr?.slice(0, 500));
		process.exit(1);
	}
	const stderr = r.stderr ?? "";
	let total = 0;
	let count = 0;
	for (const m of stderr.matchAll(re)) {
		total += Number(m[1]);
		count++;
	}
	totals.push(total);
	wallTimes.push(wall);
	counts.push(count);
	console.error(`run ${i + 1}: extensions=${count} ext_load=${total}ms wall=${wall.toFixed(0)}ms`);
}

const best = Math.min(...totals);
const avgWall = wallTimes.reduce((a, b) => a + b, 0) / wallTimes.length;
const avgCount = counts.reduce((a, b) => a + b, 0) / counts.length;

console.log(`METRIC total_extension_load_ms=${best}`);
console.log(`METRIC avg_wall_ms=${Math.round(avgWall)}`);
console.log(`METRIC extension_count=${Math.round(avgCount)}`);
