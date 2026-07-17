#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decideTarget } from "./lib/resolve-launch.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

process.env.PIT_CODING_AGENT_DIR ||= join(homedir(), ".pit", "agent");
process.env.PIT_TMP_DIR ||= join(homedir(), ".pit", "tmp");
try {
	mkdirSync(process.env.PIT_TMP_DIR, { recursive: true });
} catch {}
process.env.TMP = process.env.PIT_TMP_DIR;
process.env.TEMP = process.env.PIT_TMP_DIR;

const bundle = join(repoRoot, "packages", "coding-agent", "dist", "cli.bundle.mjs");
const srcCli = join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const tsxLoader = join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs");
const srcDirs = ["coding-agent", "agent", "ai", "tui"].map((p) => join(repoRoot, "packages", p, "src"));

const forceSrc = /^(1|true|yes)$/i.test(process.env.PIT_NO_BUNDLE ?? "");
const bundleMtimeMs = existsSync(bundle) ? statSync(bundle).mtimeMs : null;
const target = decideTarget({ bundleMtimeMs, srcDirs, forceSrc });

if (target === "bundle") {
	await import(pathToFileURL(bundle).href);
} else {
	if (!existsSync(tsxLoader)) {
		process.stderr.write(`pit: tsx not found at ${tsxLoader}. Run \`npm install\` in ${repoRoot} first.\n`);
		process.exit(1);
	}
	if (bundleMtimeMs !== null && !forceSrc && !/^(1|true|yes)$/i.test(process.env.PIT_LAUNCH_QUIET ?? "")) {
		process.stderr.write(
			"pit: src mais novo que o bundle — rodando do src via tsx (rebuild com `npm run build` para o modo rápido)\n",
		);
	}
	const child = spawn(
		process.execPath,
		["--import", pathToFileURL(tsxLoader).href, srcCli, ...process.argv.slice(2)],
		{ stdio: "inherit", env: process.env },
	);
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
}
