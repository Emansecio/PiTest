import { execFileSync, spawn } from "node:child_process";

// Overlapped parallel gate (wall-time tuned for Windows):
//   Gate — biome + tsgo (~1.2s). Must pass before vitest starts.
//   token-bench (~4-6s of tsx benches) must not fight vitest's fork startup:
//   overlapping the two produced summary-less vitest crashes (flaky pre-push,
//   audit 6.1). With vitest in the run it now starts only once vitest emits
//   its first output (vitest boot is past its fragile fork-spawn window by
//   then); it still finishes long before vitest ends (~36s), so wall-time is
//   unchanged. With --no-vitest (check:static) it starts at t=0 as before —
//   there it IS the critical path (audit 6.5).
//   Vitest — direct `npx vitest --run` from packages/coding-agent (~36s).
//            Never share a wave with tsgo/biome (oversubscription flaked E2E).
//            A run that dies WITHOUT printing a Test Files summary is a crash,
//            not a test failure — retried once (PIT_NO_CHECK_RETRY=1 disables).
//   Smokes — lightweight scripts (~0.2s each), parallel with vitest only.
//
// Output is buffered per task and printed in full. Each task gets its own spawn.

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

function run(name, command, extraEnv = undefined) {
	const started = Date.now();
	return new Promise((resolve) => {
		const child = spawn(command, {
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
		});
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
			resolve({ name, code: code ?? 1, out, ms: Date.now() - started });
		});
	});
}

async function runWave(tasks) {
	if (tasks.length === 0) return [];
	return Promise.all(tasks.map((task) => run(task.name, task.command)));
}

function isTruthyEnvFlag(name) {
	const value = (process.env[name] ?? "").toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

const skipTsgo = process.argv.includes("--skip-tsgo") || process.env.CHECK_SKIP_TSGO === "1";
const skipVitest = process.argv.includes("--no-vitest");
const vitestUnit = process.argv.includes("--vitest-unit");
const workspaceTests = process.argv.includes("--workspace-tests");
const showTiming = process.env.CHECK_TIMING === "1";
const noCheckRetry = isTruthyEnvFlag("PIT_NO_CHECK_RETRY");
const noChangedOnly = isTruthyEnvFlag("PIT_NO_CHANGED_ONLY");

const gateTasks = [
	{ name: "biome", command: "npx biome check --error-on-warnings ." },
	...(skipTsgo ? [] : [{ name: "tsgo", command: "npx tsgo --noEmit" }]),
];

// token-bench fingerprint cache (audit 6.5): only the pre-commit path
// (--no-vitest / check:static) may skip on an unchanged-inputs PASS — there
// token-bench IS the whole critical path. The full check (pre-push) and CI
// always run the benches for real, so `--cache` is not passed to them.
// PIT_NO_BENCH_CACHE=1 forces a real run on every path.
const tokenBenchCacheEligible = skipVitest && !process.env.CI;
const tokenBenchTask = {
	name: "token-bench",
	command: `node scripts/check-token-bench.mjs${tokenBenchCacheEligible ? " --cache" : ""}`,
};

// check:fast (--vitest-unit): run only tests related to the working-tree diff
// via vitest's native git-aware `--changed`. The unit config's exclusions are
// not what makes check:fast slow — per-fork collect/transform of the whole TS
// graph is — so changed-only is what actually buys the "fast" (audit 6.4).
// Plain `--changed` (uncommitted changes, staged + unstaged) matches the local
// dev-loop semantics: the full suite still gates on pre-push via `npm run
// check`. Falls back to the full unit suite when the diff touches high-fan-in
// core files (their import graphs reach almost everything, so changed-only
// would be both slow and low-signal), when git fails, or with
// PIT_NO_CHANGED_ONLY=1.
const CORE_FALLBACK_PATTERNS = [
	/(^|\/)package(-lock)?\.json$/,
	/(^|\/)vitest[^/]*\.config\.(m?[jt]s)$/,
	/(^|\/)tsconfig[^/]*\.json$/,
	/^packages\/coding-agent\/src\/core\/agent-session\.ts$/,
	/^packages\/agent\/src\/agent-loop\.ts$/,
];

function listChangedFiles() {
	const opts = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
	const diff = execFileSync("git", ["diff", "--name-only", "HEAD"], opts);
	const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], opts);
	return [...new Set(`${diff}\n${untracked}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

function resolveVitestUnitCommand() {
	const fullUnit = "npx vitest --config vitest.unit.config.ts --run";
	if (noChangedOnly) {
		return { command: fullUnit, note: "full unit suite (PIT_NO_CHANGED_ONLY=1)" };
	}
	let changed;
	try {
		changed = listChangedFiles();
	} catch {
		return { command: fullUnit, note: "full unit suite (git diff failed)" };
	}
	const coreHit = changed.find((file) => CORE_FALLBACK_PATTERNS.some((re) => re.test(file)));
	if (coreHit) {
		return { command: fullUnit, note: `full unit suite (high fan-in file changed: ${coreHit})` };
	}
	return {
		command: `${fullUnit} --changed --passWithNoTests`,
		note: `changed-only, ${changed.length} changed file(s) (PIT_NO_CHANGED_ONLY=1 for the full unit suite)`,
	};
}

const vitestUnitPlan = vitestUnit && !skipVitest ? resolveVitestUnitCommand() : undefined;
if (vitestUnitPlan) {
	console.log(`vitest: ${vitestUnitPlan.note}`);
}
const vitestTask = {
	name: "vitest",
	command: vitestUnitPlan ? vitestUnitPlan.command : "npx vitest --run",
	cwd: "packages/coding-agent",
};

const smokeTasks = [
	{ name: "browser-smoke", command: "node scripts/check-browser-smoke.mjs" },
	{ name: "generated", command: "node scripts/check-generated-models.mjs" },
	{ name: "dist-exports", command: "node scripts/check-dist-exports.mjs" },
	{ name: "surrogate-slice", command: "node scripts/check-surrogate-slice.mjs" },
	{ name: "bench-selftest", command: "npx tsx bench/selftest.mts" },
	{ name: "extension-load", command: "node scripts/check-extension-load.mjs" },
];

// Vitest on Windows often prints the final summary then keeps fork workers alive;
// the parent shell never gets `close`. Once the summary shows all files passed,
// reap the tree after a short grace period so the gate can finish.
const VITEST_SUMMARY_PASSED_RE = /Test Files\s+\d+ passed/;
const VITEST_SUMMARY_FAILED_RE = /\bFAIL\b|Test Files\s+.*\bfailed\b/;
// Any Test Files summary line at all — its absence on a non-zero exit means the
// vitest process died (crash), not that tests failed (audit 6.1).
const VITEST_SUMMARY_ANY_RE = /Test Files\s+\d+/;

function runVitest(name, command, cwd, onFirstOutput) {
	const started = Date.now();
	return new Promise((resolve) => {
		const child = spawn(command, { shell: true, cwd, stdio: ["ignore", "pipe", "pipe"] });
		activeChildren.add(child);
		let out = "";
		let settled = false;
		let sawOutput = false;
		let reapTimer;

		const finish = (code) => {
			if (settled) return;
			settled = true;
			if (reapTimer) clearTimeout(reapTimer);
			activeChildren.delete(child);
			resolve({ name, code, out, ms: Date.now() - started });
		};

		const append = (chunk) => {
			out += chunk;
			if (!sawOutput) {
				sawOutput = true;
				onFirstOutput?.();
			}
			if (settled || VITEST_SUMMARY_FAILED_RE.test(out)) return;
			if (VITEST_SUMMARY_PASSED_RE.test(out) && reapTimer === undefined) {
				reapTimer = setTimeout(() => {
					if (!settled) {
						killTree(child);
						finish(0);
					}
				}, 2500);
			}
		};

		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.on("close", (code) => finish(code ?? 1));
	});
}

// Distinguish "vitest crashed" (non-zero exit, no Test Files summary in the
// buffer — the process died before reporting) from "tests failed" (summary
// present). Crashes get exactly one automatic re-run; real failures never do.
// PIT_NO_CHECK_RETRY=1 restores the old fail-fast behavior.
async function runVitestWithRetry(task, onFirstOutput) {
	const first = await runVitest(task.name, task.command, task.cwd, onFirstOutput);
	// Whatever happened, unblock anything gated on vitest's first output (a
	// crash can die before emitting a single byte).
	onFirstOutput?.();
	if (first.code === 0 || noCheckRetry) return first;
	if (VITEST_SUMMARY_ANY_RE.test(first.out)) return first;
	console.error("\nvitest crashed without summary — retrying once (PIT_NO_CHECK_RETRY=1 to disable)");
	const retry = await runVitest(task.name, task.command, task.cwd);
	const banner =
		"vitest crashed without summary — retried once (PIT_NO_CHECK_RETRY=1 to disable)\n" +
		`--- first run (crashed, exit ${first.code}) last output ---\n${first.out.slice(-2000)}\n` +
		"--- retry run ---\n";
	return { ...retry, out: banner + retry.out, ms: first.ms + retry.ms };
}

const gateStarted = Date.now();

// token-bench start gate: released immediately when vitest is skipped
// (check:static — token-bench is the critical path there), otherwise released
// by vitest's first output so the tsx benches never fight vitest's fork
// startup. See the wall-time notes at the top of this file.
let releaseTokenBench;
let tokenBenchReleased = false;
const tokenBenchGate = new Promise((resolve) => {
	releaseTokenBench = () => {
		tokenBenchReleased = true;
		resolve();
	};
});
const tokenBenchPromise = (async () => {
	await tokenBenchGate;
	return run(tokenBenchTask.name, tokenBenchTask.command);
})();
if (skipVitest) releaseTokenBench();

const gateStartedAt = Date.now();
const gateResults = await runWave(gateTasks);
const gateMs = Date.now() - gateStartedAt;

const gateFailed = gateResults.filter((result) => result.code !== 0);
if (gateFailed.length > 0) {
	for (const result of gateResults) {
		if (result.out.trim()) {
			process.stdout.write(`\n=== ${result.name} ===\n${result.out}`);
		}
	}
	// token-bench only started here in --no-vitest mode (see the start gate);
	// in vitest mode it is still unreleased at gate failure, so skip it.
	if (tokenBenchReleased) {
		const tokenBenchResult = await tokenBenchPromise;
		if (tokenBenchResult.out.trim()) {
			process.stdout.write(`\n=== ${tokenBenchResult.name} ===\n${tokenBenchResult.out}`);
		}
	}
	console.error(`\ncheck failed: ${gateFailed.map((result) => result.name).join(", ")}`);
	process.exit(1);
}

const heavyStartedAt = Date.now();
// coding-agent is deliberately excluded when vitestTask runs: its suite already
// executes as vitestTask in this same wave, so listing it here would run the
// whole 400+ file suite twice. Enumerate the test-bearing workspaces explicitly
// and run each package in parallel (npm workspaces test is otherwise serial).
// With --no-vitest the coding-agent workspace is added back so its tests still
// run exactly once.
const workspaceTestWorkspaces = [
	"packages/ai",
	"packages/agent",
	"packages/tui",
	...(skipVitest ? ["packages/coding-agent"] : []),
];
const workspaceTestPromises = workspaceTests
	? workspaceTestWorkspaces.map((workspace) => {
			const name = `workspace-tests:${workspace.replace(/^packages\//, "")}`;
			const env = workspace === "packages/ai" ? { PIT_AI_SKIP_LOCAL_AUTH: "1" } : undefined;
			return run(name, `npm test --workspace ${workspace} --if-present`, env);
		})
	: [];

const heavyPromises = [
	tokenBenchPromise,
	...(skipVitest ? [] : [runVitestWithRetry(vitestTask, releaseTokenBench)]),
	...workspaceTestPromises,
	...smokeTasks.map((task) => run(task.name, task.command)),
];
const heavyResults = await Promise.all(heavyPromises);
const heavyMs = Date.now() - heavyStartedAt;

const results = [...gateResults, ...heavyResults];
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

if (showTiming) {
	const totalMs = Date.now() - gateStarted;
	const vitestResult = results.find((r) => r.name === "vitest");
	const smokeMs = smokeTasks.reduce((max, task) => {
		const r = results.find((res) => res.name === task.name);
		return Math.max(max, r?.ms ?? 0);
	}, 0);
	const parts = results.map((r) => `${r.name}=${r.ms}ms`).join(" ");
	console.log(
		`\ncheck timing: gate=${gateMs}ms heavy=${heavyMs}ms smokes=${smokeMs}ms total=${totalMs}ms (${parts})`,
	);
	if (vitestResult) {
		console.log(`vitest wall: ${vitestResult.ms}ms`);
	}
	if (vitestResult && vitestResult.code === 0) {
		const slow = await run("slow-tests", "node scripts/report-slow-tests.mjs");
		if (slow.out.trim()) {
			process.stdout.write(`\n=== ${slow.name} ===\n${slow.out}`);
		}
	}
}

// Vitest (and occasional smoke children) can leave handles open on Windows;
// exit explicitly once all tasks reported so `npm run check` does not hang.
process.exit(0);
