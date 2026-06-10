import { spawn } from "node:child_process";

// Run the independent check tasks in parallel instead of chaining them with
// &&. Output is buffered per task and printed in full (no truncation) so
// errors stay readable. Exits non-zero if any task fails.
//
// Each task gets its own isolated spawn with its exit code captured
// independently, so a vitest `exit 1` only fails that task — it never cancels
// the others (the "exit 1 cancels the batch on Windows" issue is specific to
// `&&`-chained shells, not this Promise.all fan-out).

function run(name, command) {
	return new Promise((resolve) => {
		const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			out += chunk;
		});
		child.on("close", (code) => {
			resolve({ name, code: code ?? 1, out });
		});
	});
}

const tasks = [
	{ name: "biome", command: "biome check --error-on-warnings ." },
	{ name: "tsgo", command: "tsgo --noEmit" },
	{ name: "browser-smoke", command: "node scripts/check-browser-smoke.mjs" },
	{ name: "generated", command: "node scripts/check-generated-models.mjs" },
	// Vitest unit/integration suite — keeps assertions like footer.test.ts from
	// silently rotting (this gate previously ran only type/lint/smoke checks).
	{ name: "vitest", command: "npm run test -w @pit/coding-agent" },
];

const results = await Promise.all(tasks.map((task) => run(task.name, task.command)));
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
