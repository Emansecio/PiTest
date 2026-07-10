import { spawn } from "node:child_process";

// Overlapped parallel gate (wall-time tuned for Windows):
//   Gate — biome + tsgo (~1.2s). Must pass before vitest starts.
//   token-bench starts at t=0 in the background (~3s of tsx benches); it must
//   not share a wave with vitest (fork/spawn tests fight the benches), but it
//   finishes long before vitest ends so we overlap it with the gate + vitest
//   instead of blocking vitest behind a full wave-1 barrier.
//   Vitest — direct `npx vitest --run` from packages/coding-agent (~36s).
//            Never share a wave with tsgo/biome (oversubscription flaked E2E).
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

const skipTsgo = process.argv.includes("--skip-tsgo") || process.env.CHECK_SKIP_TSGO === "1";
const skipVitest = process.argv.includes("--no-vitest");
const vitestUnit = process.argv.includes("--vitest-unit");
const workspaceTests = process.argv.includes("--workspace-tests");
const showTiming = process.env.CHECK_TIMING === "1";

const gateTasks = [
	{ name: "biome", command: "npx biome check --error-on-warnings ." },
	...(skipTsgo ? [] : [{ name: "tsgo", command: "npx tsgo --noEmit" }]),
];

const tokenBenchTask = { name: "token-bench", command: "node scripts/check-token-bench.mjs" };
const vitestTask = {
	name: "vitest",
	command: vitestUnit
		? "npx vitest --config vitest.unit.config.ts --run"
		: "npx vitest --run",
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

function runWithCwd(name, command, cwd) {
	const started = Date.now();
	return new Promise((resolve) => {
		const child = spawn(command, { shell: true, cwd, stdio: ["ignore", "pipe", "pipe"] });
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

// Vitest on Windows often prints the final summary then keeps fork workers alive;
// the parent shell never gets `close`. Once the summary shows all files passed,
// reap the tree after a short grace period so the gate can finish.
const VITEST_SUMMARY_PASSED_RE = /Test Files\s+\d+ passed/;
const VITEST_SUMMARY_FAILED_RE = /\bFAIL\b|Test Files\s+.*\bfailed\b/;

function runVitest(name, command, cwd) {
	const started = Date.now();
	return new Promise((resolve) => {
		const child = spawn(command, { shell: true, cwd, stdio: ["ignore", "pipe", "pipe"] });
		activeChildren.add(child);
		let out = "";
		let settled = false;
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

async function runTask(task) {
	if (task.name === "vitest" && task.cwd) {
		return runVitest(task.name, task.command, task.cwd);
	}
	if (task.cwd) {
		return runWithCwd(task.name, task.command, task.cwd);
	}
	return run(task.name, task.command);
}

const gateStarted = Date.now();
const tokenBenchPromise = run(tokenBenchTask.name, tokenBenchTask.command);

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
	const tokenBenchResult = await tokenBenchPromise;
	if (tokenBenchResult.out.trim()) {
		process.stdout.write(`\n=== ${tokenBenchResult.name} ===\n${tokenBenchResult.out}`);
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
	...(skipVitest ? [] : [runTask(vitestTask)]),
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
