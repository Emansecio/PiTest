import { spawn } from "node:child_process";

// Run the independent check tasks in parallel instead of chaining them with
// &&. Output is buffered per task and printed in full (no truncation) so
// errors stay readable. Exits non-zero if any task fails.
//
// Each task gets its own isolated spawn with its exit code captured
// independently, so a vitest `exit 1` only fails that task — it never cancels
// the others (the "exit 1 cancels the batch on Windows" issue is specific to
// `&&`-chained shells, not this Promise.all fan-out).

// Track live children so an interrupted runner (Ctrl-C, SIGTERM, a parent that
// dies) reaps the whole spawned tree instead of orphaning it. On Windows,
// killing the shell does NOT kill its descendants (npm -> vitest -> N forks), so
// we taskkill the tree by pid; POSIX gets a direct kill signal.
const activeChildren = new Set();

function killTree(child) {
	if (child.pid === undefined) return;
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
	} else {
		child.kill("SIGKILL");
	}
}

function shutdown(signal) {
	for (const child of activeChildren) {
		killTree(child);
	}
	process.exit(signal === "SIGINT" ? 130 : 143);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function run(name, command) {
	return new Promise((resolve) => {
		const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
		activeChildren.add(child);
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			out += chunk;
		});
		child.on("close", (code) => {
			activeChildren.delete(child);
			resolve({ name, code: code ?? 1, out });
		});
	});
}

// The fast static checks. tsgo (~3s) and biome (~1s) are CPU-bound but brief;
// the two smoke checks are trivial. These run concurrently with each other.
const fastChecks = [
	{ name: "biome", command: "biome check --error-on-warnings ." },
	{ name: "tsgo", command: "tsgo --noEmit" },
	{ name: "browser-smoke", command: "node scripts/check-browser-smoke.mjs" },
	{ name: "generated", command: "node scripts/check-generated-models.mjs" },
	{ name: "surrogate-slice", command: "node scripts/check-surrogate-slice.mjs" },
	{ name: "token-bench", command: "node scripts/check-token-bench.mjs" },
];

// Vitest is the heavy task: it forks up to (cpu-count) workers and saturates
// every core during its ~280s-CPU collect. Running it inside the SAME parallel
// batch as tsgo/biome oversubscribes the machine — that contention is what made
// timing-sensitive tests (real-timer polling, process-spawn E2E) flake on the
// 30s deadline, even though the suite is rock-stable solo (~21s, 2495 green).
// So: finish the fast checks first, then give vitest the machine to itself. Net
// wall is LOWER than the old contended run AND deterministic. All tasks still
// run (no early bail) so one failure never hides another, and the suite is never
// skipped. Keeps the footer.test.ts-style assertions from silently rotting.
const vitestTask = { name: "vitest", command: "npm run test -w @pit/coding-agent" };

// `--no-vitest` (used by the pre-commit hook) runs ONLY the fast static checks so
// commits stay ~5s. The full vitest suite still runs on pre-push and on a bare
// `npm run check`. Keeps the per-commit cost low without losing the gate.
const skipVitest = process.argv.includes("--no-vitest");

const fastResults = await Promise.all(fastChecks.map((task) => run(task.name, task.command)));
const vitestResult = skipVitest ? null : await run(vitestTask.name, vitestTask.command);
const results = skipVitest ? fastResults : [...fastResults, vitestResult];
for (const result of results) {
	if (result.out.trim()) {
		process.stdout.write(`\n=== ${result.name} ===\n${result.out}`);
	}
}
const failed = results.filter((result) => result.code !== 0);
if (failed.length > 0) {
	console.error(`\ncheck failed: ${failed.map((result) => result.name).join(", ")}`);
	process.exit(1);
}
