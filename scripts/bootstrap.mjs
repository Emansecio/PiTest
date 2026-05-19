#!/usr/bin/env node
/**
 * PiTuned bootstrap.
 *
 * Run once after cloning the repo on a fresh machine. Idempotent.
 *
 * What it does:
 *   1. Verifies node_modules exists at repo root; runs `npm install` if not.
 *   2. Reads the canonical package list from .pi/packages.json and runs
 *      `pi install npm:<name>` for any package missing in ~/.pi/agent/npm/.
 *   3. Runs scripts/precompile-pi-packages.mjs so the loader can skip jiti
 *      transpilation on every startup.
 *
 * Flags:
 *   --no-install        Skip running `npm install`.
 *   --no-pi-install     Skip installing pi packages (assume already there).
 *   --no-precompile     Skip the precompile step.
 *   --force-precompile  Pass --force to the precompile script.
 *
 * Respects PI_CODING_AGENT_DIR / PI_NPM_DIR overrides.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PACKAGES_MANIFEST = join(REPO_ROOT, ".pi", "packages.json");

const flags = new Set(process.argv.slice(2));
const SKIP_NPM = flags.has("--no-install");
const SKIP_PI_INSTALL = flags.has("--no-pi-install");
const SKIP_PRECOMPILE = flags.has("--no-precompile");
const FORCE_PRECOMPILE = flags.has("--force-precompile");
const SKIP_CLONE = flags.has("--no-clone");

// PiTuned isolates its state from stock pi by defaulting the agent dir to
// ~/.pit/agent/. Honor an explicit PI_CODING_AGENT_DIR override.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR
	? process.env.PI_CODING_AGENT_DIR.replace(/^~(?=$|\/|\\)/, homedir())
	: join(homedir(), ".pit", "agent");
const STOCK_AGENT_DIR = join(homedir(), ".pi", "agent");
const NPM_DIR = process.env.PI_NPM_DIR ?? join(AGENT_DIR, "npm", "node_modules");

function log(msg) {
	console.log(`[bootstrap] ${msg}`);
}

function exists(p) {
	return existsSync(p);
}

function run(cmd, args, opts = {}) {
	const { env: extraEnv, ...rest } = opts;
	const r = spawnSync(cmd, args, {
		cwd: REPO_ROOT,
		stdio: "inherit",
		shell: platform() === "win32",
		env: extraEnv ?? process.env,
		...rest,
	});
	if (r.status !== 0) {
		throw new Error(`Command failed: ${cmd} ${args.join(" ")} (exit ${r.status})`);
	}
}

// 1) npm install at repo root
if (!SKIP_NPM) {
	if (!exists(join(REPO_ROOT, "node_modules"))) {
		log("node_modules missing — running `npm install`");
		run("npm", ["install"]);
	} else {
		log("node_modules present — skipping `npm install` (use without --no-install to force)");
	}
}

// 1b) First-time clone of stock pi's agent dir into PiTuned's isolated dir.
// We only run this if AGENT_DIR doesn't exist yet AND the stock dir does.
// Subsequent runs leave both alone — they evolve independently.
if (!SKIP_CLONE && !exists(AGENT_DIR) && exists(STOCK_AGENT_DIR) && AGENT_DIR !== STOCK_AGENT_DIR) {
	log(`first-time setup: cloning ${STOCK_AGENT_DIR} -> ${AGENT_DIR}`);
	mkdirSync(AGENT_DIR, { recursive: true });
	// Copy everything except backup/cache files that would just bloat the clone.
	const stockCacheDir = join(STOCK_AGENT_DIR, "cache");
	cpSync(STOCK_AGENT_DIR, AGENT_DIR, {
		recursive: true,
		dereference: false,
		filter: (src) => {
			const base = src.split(/[\\/]/).pop() ?? "";
			// Skip settings backups — they bloat the clone and aren't useful.
			if (base.startsWith("settings.json.bak")) return false;
			// Skip jiti fs cache root — will be rebuilt on first run.
			if (src === stockCacheDir || src.startsWith(stockCacheDir + "/") || src.startsWith(stockCacheDir + "\\")) return false;
			return true;
		},
	});
	rewriteClonedSettings(join(AGENT_DIR, "settings.json"), STOCK_AGENT_DIR, AGENT_DIR);
	log(`clone done. From now on PiTuned uses ${AGENT_DIR} and stock pi uses ${STOCK_AGENT_DIR}.`);
} else if (exists(AGENT_DIR)) {
	log(`agent dir present: ${AGENT_DIR}`);
} else if (!exists(STOCK_AGENT_DIR)) {
	log(`agent dir empty: ${AGENT_DIR} (no stock pi install found to clone from)`);
}

// 2) Pi packages
/**
 * Rewrite absolute path references inside the cloned settings.json so they
 * point at the new agent dir instead of the source one. Without this, the
 * settings still reference paths under ~/.pi/agent/ and PiTuned silently
 * mixes state from both dirs.
 */
function rewriteClonedSettings(settingsFile, fromDir, toDir) {
	if (!existsSync(settingsFile)) return;
	let text;
	try {
		text = readFileSync(settingsFile, "utf8");
	} catch {
		return;
	}
	// Match both forward and backslash forms of the source dir.
	const fromFwd = fromDir.replace(/\\/g, "/");
	const fromBwd = fromDir.replace(/\//g, "\\");
	const toFwd = toDir.replace(/\\/g, "/");
	const toBwd = toDir.replace(/\//g, "\\\\");
	let rewritten = text;
	if (fromFwd && fromFwd !== toFwd) {
		rewritten = rewritten.split(fromFwd).join(toFwd);
	}
	if (fromBwd && fromBwd !== toBwd) {
		rewritten = rewritten.split(fromBwd).join(toBwd);
	}
	if (rewritten !== text) {
		writeFileSync(settingsFile, rewritten);
		log(`rewrote absolute paths in ${settingsFile}`);
	}
}

function readPackageList() {
	if (!exists(PACKAGES_MANIFEST)) {
		return [];
	}
	try {
		const data = JSON.parse(readFileSync(PACKAGES_MANIFEST, "utf8"));
		return Array.isArray(data.packages) ? data.packages : [];
	} catch (e) {
		log(`WARN: could not parse ${PACKAGES_MANIFEST}: ${e.message}`);
		return [];
	}
}

function isPackageInstalled(spec) {
	const name = spec.replace(/^npm:/, "").replace(/@\d.*$/, "");
	return exists(join(NPM_DIR, ...name.split("/")));
}

if (!SKIP_PI_INSTALL) {
	const packages = readPackageList();
	if (packages.length === 0) {
		log(`no .pi/packages.json found — skipping pi install`);
	} else {
		const missing = packages.filter((spec) => !isPackageInstalled(spec));
		if (missing.length === 0) {
			log(`all ${packages.length} pi packages already installed in ${NPM_DIR}`);
		} else {
			log(`installing ${missing.length}/${packages.length} missing pi packages into ${AGENT_DIR}`);
			const tsxBin = join(REPO_ROOT, "node_modules", ".bin", platform() === "win32" ? "tsx.cmd" : "tsx");
			const cliPath = join(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts");
			// Ensure pi runs against PiTuned's isolated dir.
			const env = { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR };
			for (const spec of missing) {
				log(`  pit install ${spec}`);
				try {
					execFileSync(tsxBin, [cliPath, "install", spec], { cwd: REPO_ROOT, stdio: "inherit", env });
				} catch (e) {
					log(`  WARN: ${spec} failed (${e.message ?? e}). Continuing.`);
				}
			}
		}
	}
}

// 3) Precompile (runs against the same AGENT_DIR PiTuned uses)
if (!SKIP_PRECOMPILE) {
	log("pre-compiling pi packages");
	const args = ["scripts/precompile-pi-packages.mjs"];
	if (FORCE_PRECOMPILE) args.push("--force");
	run("node", args, { env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR } });
}

log("done");
