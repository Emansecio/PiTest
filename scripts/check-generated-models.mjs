import { execFileSync, spawnSync } from "node:child_process";

const generatedFiles = ["packages/ai/src/models.generated.ts", "packages/ai/src/image-models.generated.ts"];

if (process.env.CI !== "true" && process.env.PI_CHECK_GENERATED !== "1") {
	process.exit(0);
}

function git(args) {
	return spawnSync("git", args, { encoding: "utf-8" });
}

const insideWorkTree = git(["rev-parse", "--is-inside-work-tree"]);
if (insideWorkTree.status !== 0 || insideWorkTree.stdout.trim() !== "true") {
	process.exit(0);
}

const diff = git(["diff", "--", ...generatedFiles]);
if (diff.status !== 0) {
	process.stderr.write(diff.stderr || "Failed to inspect generated model diffs.\n");
	process.exit(diff.status ?? 1);
}

if (diff.stdout.trim().length === 0) {
	process.exit(0);
}

const changed = execFileSync("git", ["diff", "--name-only", "--", ...generatedFiles], { encoding: "utf-8" })
	.trim()
	.split("\n")
	.filter(Boolean);

process.stderr.write(`Generated model files are not fresh:\n${changed.map((file) => `  - ${file}`).join("\n")}\n\n`);
process.stderr.write(
	"Run `npm --prefix packages/ai run generate-models` and `npm --prefix packages/ai run generate-image-models`, then commit the generated output. Do not edit generated files by hand. Set PI_CHECK_GENERATED=1 to run this check locally.\n",
);
process.exit(1);
