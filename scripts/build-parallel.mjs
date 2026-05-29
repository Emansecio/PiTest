import { spawn } from "node:child_process";

// Build packages respecting the dependency graph:
//   wave 1: tui + ai   (independent, run in parallel)
//   wave 2: agent      (needs ai/dist)
//   wave 3: coding-agent (needs tui/ai/agent dist)
// Replaces the previous fully-serial chain.

function run(name) {
	return new Promise((resolve) => {
		const child = spawn("npm run build", { cwd: `packages/${name}`, shell: true, stdio: ["ignore", "pipe", "pipe"] });
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

async function wave(names) {
	const results = await Promise.all(names.map((name) => run(name)));
	for (const result of results) {
		if (result.out.trim()) {
			process.stdout.write(`\n=== ${result.name} ===\n${result.out}`);
		}
	}
	const failed = results.filter((result) => result.code !== 0);
	if (failed.length > 0) {
		console.error(`\nbuild failed: ${failed.map((result) => result.name).join(", ")}`);
		process.exit(1);
	}
}

await wave(["tui", "ai"]);
await wave(["agent"]);
await wave(["coding-agent"]);
