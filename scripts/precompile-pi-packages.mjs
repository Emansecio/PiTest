#!/usr/bin/env node
/**
 * Pre-compile TypeScript sources of installed pi packages AND local extension
 * dirs to JavaScript, so the loader can skip jiti transpilation on every startup.
 *
 * What it does:
 *   1. Walks ~/.pit/agent/npm/node_modules for pi packages
 *      (those with "pi" or "pi-extension" keyword, OR a `pi` field in package.json)
 *   2. Reads package.json#pi.extensions (list of dirs/files relative to package root)
 *   3. For each .ts file in those paths, emits a sibling .js via esbuild
 *   4. Skips packages that already ship .js (dist-style)
 *   5. Also walks ~/.pit/agent/extensions/ and <cwd>/.pit/extensions/ (flat .ts
 *      files and nested dirs) — same mtime / --force / --clean contract
 *
 * Safe to re-run. Pass --force to overwrite existing .js outputs.
 * Pass --clean to delete generated .js files instead.
 * Pass --cwd <path> to set the project root for `.pit/extensions` (default: process.cwd()).
 */

import { build } from "esbuild";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const FORCE = process.argv.includes("--force");
const CLEAN = process.argv.includes("--clean");
const VERBOSE = process.argv.includes("--verbose");

function argValue(flag) {
	const i = process.argv.indexOf(flag);
	if (i < 0 || i + 1 >= process.argv.length) return undefined;
	return process.argv[i + 1];
}

const PROJECT_CWD = resolve(argValue("--cwd") ?? process.cwd());

// Respect PIT_CODING_AGENT_DIR (and PIT_NPM_DIR override) so this script
// works regardless of where the user's pi agent dir lives.
const AGENT_DIR = process.env.PIT_CODING_AGENT_DIR
	? process.env.PIT_CODING_AGENT_DIR.replace(/^~(?=$|\/|\\)/, homedir())
	: join(homedir(), ".pit", "agent");
const NPM_DIR = process.env.PIT_NPM_DIR ?? join(AGENT_DIR, "npm", "node_modules");
const AGENT_EXTENSIONS_DIR = join(AGENT_DIR, "extensions");
const PROJECT_EXTENSIONS_DIR = join(PROJECT_CWD, ".pit", "extensions");

/** Find pi packages (those with a `pi` field in package.json). */
function findPiPackages(root) {
	const found = [];
	if (!existsSync(root)) return found;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, entry.name);
		if (entry.name.startsWith("@")) {
			// Scoped: iterate inner directories
			for (const inner of readdirSync(dir, { withFileTypes: true })) {
				if (!inner.isDirectory()) continue;
				const innerDir = join(dir, inner.name);
				const pkg = readPkg(innerDir);
				if (pkg?.pit) found.push({ dir: innerDir, pkg });
			}
		} else {
			const pkg = readPkg(dir);
			if (pkg?.pit) found.push({ dir, pkg });
		}
	}
	return found;
}

function readPkg(dir) {
	const file = join(dir, "package.json");
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

const SKIP_DIRS = new Set(["node_modules", "dist", "test", "tests", "__tests__", ".git", "coverage"]);

function walkTsFiles(rootDir, out = []) {
	if (!existsSync(rootDir)) return out;
	for (const e of readdirSync(rootDir, { withFileTypes: true })) {
		const p = join(rootDir, e.name);
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name)) continue;
			walkTsFiles(p, out);
		} else if (e.isFile() && p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.endsWith(".test.ts")) {
			out.push(p);
		}
	}
	return out;
}

/**
 * Collect all .ts files that may be needed at runtime by the declared
 * extension entries.
 *
 * For directory entries, walk that directory recursively.
 *
 * For file entries (e.g. `./index.ts`), walking just that file misses
 * sibling deps the file imports (e.g. `./extract.ts`), leaving the
 * precompiled .js with dangling `./extract.js` imports. To handle this we
 * walk the closest meaningful root: if the entry sits directly under the
 * package root, walk the whole package; otherwise walk the entry's parent
 * directory.
 */
function collectTsFiles(packageDir, relativePath) {
	const target = resolve(packageDir, relativePath);
	if (!existsSync(target)) return [];
	const stat = statSync(target);
	if (stat.isFile()) {
		if (!target.endsWith(".ts") || target.endsWith(".d.ts")) return [];
		const parent = dirname(target);
		// If entry lives directly in package root, walk the whole package to
		// catch sibling deps (e.g. ./extract.ts referenced from ./index.ts).
		const walkRoot = parent === packageDir ? packageDir : parent;
		return walkTsFiles(walkRoot);
	}
	return walkTsFiles(target);
}

/** Map .ts file path to its .js sibling path. */
function jsSibling(tsPath) {
	return tsPath.slice(0, -extname(tsPath).length) + ".js";
}

async function compileFile(tsPath) {
	const jsPath = jsSibling(tsPath);
	if (!FORCE && existsSync(jsPath)) {
		// Skip if .js newer than .ts
		try {
			const tsStat = statSync(tsPath);
			const jsStat = statSync(jsPath);
			if (jsStat.mtimeMs >= tsStat.mtimeMs) return { tsPath, jsPath, skipped: true };
		} catch {}
	}
	await build({
		entryPoints: [tsPath],
		outfile: jsPath,
		bundle: false,
		platform: "node",
		format: "esm",
		target: "node22",
		sourcemap: "inline",
		logLevel: "silent",
	});
	// Esbuild keeps `.ts` import specifiers verbatim when bundling is off,
	// which makes jiti walk back to the original TS file and re-transpile it.
	// Rewrite relative `.ts` / `.tsx` imports to `.js` so the loader sees the
	// compiled siblings instead.
	rewriteTsImportSpecifiers(jsPath);
	return { tsPath, jsPath, skipped: false };
}

function rewriteTsImportSpecifiers(jsPath) {
	let src;
	try {
		src = readFileSync(jsPath, "utf8");
	} catch {
		return;
	}
	let rewritten = src
		// import ... from "./x.ts" | "../x.tsx"
		.replace(/(from\s*["'])(\.{1,2}\/[^"']+?)\.tsx?(["'])/g, "$1$2.js$3")
		// import("./x.ts")
		.replace(/(import\(\s*["'])(\.{1,2}\/[^"']+?)\.tsx?(["']\s*\))/g, "$1$2.js$3")
		// export ... from "./x.ts"
		.replace(/(export\s*(?:\*|\{[^}]*\})\s*from\s*["'])(\.{1,2}\/[^"']+?)\.tsx?(["'])/g, "$1$2.js$3");
	// Rewrite legacy @pituned/* aliases to the canonical @pit/*
	// scope so Node ESM resolves them via node_modules without needing the
	// coding-agent jiti alias map.
	rewritten = rewritten.replace(/@pituned\/pi-/g, "@pit/");
	if (rewritten !== src) {
		writeFileSync(jsPath, rewritten);
	}
}

function cleanFile(tsPath) {
	const jsPath = jsSibling(tsPath);
	if (existsSync(jsPath)) {
		try {
			unlinkSync(jsPath);
			return true;
		} catch {
			return false;
		}
	}
	return false;
}

async function processTsList(label, allTs, baseDir) {
	if (allTs.length === 0) {
		return { name: label, files: 0, skipped: 0, cleaned: 0, ms: 0 };
	}
	const start = performance.now();
	let compiled = 0;
	let skipped = 0;
	let cleaned = 0;
	for (const ts of allTs) {
		if (CLEAN) {
			if (cleanFile(ts)) cleaned++;
		} else {
			const r = await compileFile(ts);
			if (r.skipped) skipped++;
			else {
				compiled++;
				if (VERBOSE) console.log(`  + ${relative(baseDir, r.jsPath)}`);
			}
		}
	}
	const ms = performance.now() - start;
	return { name: label, files: compiled, skipped, cleaned, ms };
}

async function processPackage(pkgInfo) {
	const { dir, pkg } = pkgInfo;
	const extensions = pkg.pi?.extensions ?? [];
	if (!Array.isArray(extensions) || extensions.length === 0) {
		return { name: pkg.name, files: 0, skipped: 0, ms: 0 };
	}
	const allTs = [];
	for (const ext of extensions) {
		const files = collectTsFiles(dir, ext);
		allTs.push(...files);
	}
	return processTsList(pkg.name, allTs, dir);
}

/** Flat / nested local extension dirs (agent + project `.pit/extensions`). */
async function processLocalExtensionsDir(dir, label) {
	if (!existsSync(dir)) {
		return { name: label, files: 0, skipped: 0, cleaned: 0, ms: 0 };
	}
	const allTs = walkTsFiles(dir);
	return processTsList(label, allTs, dir);
}

const t0 = performance.now();
const packages = findPiPackages(NPM_DIR);
if (existsSync(NPM_DIR)) {
	console.log(`${CLEAN ? "Cleaning" : "Pre-compiling"} ${packages.length} pi packages from ${NPM_DIR}\n`);
} else {
	console.log(`Pi npm dir not found (${NPM_DIR}) — skipping package precompile; continuing with local extensions.\n`);
}

let totalCompiled = 0;
let totalSkipped = 0;
let totalCleaned = 0;

function accumulate(r) {
	if (r.files === 0 && r.skipped === 0 && !r.cleaned) return;
	totalCompiled += r.files ?? 0;
	totalSkipped += r.skipped ?? 0;
	totalCleaned += r.cleaned ?? 0;
	const tag = CLEAN ? `cleaned=${r.cleaned}` : `compiled=${r.files} skipped=${r.skipped}`;
	console.log(`  ${String(r.name).padEnd(40)} ${tag} (${r.ms.toFixed(0)}ms)`);
}

for (const p of packages) {
	accumulate(await processPackage(p));
}

console.log(`\nLocal extension dirs:`);
accumulate(await processLocalExtensionsDir(AGENT_EXTENSIONS_DIR, `agent:${AGENT_EXTENSIONS_DIR}`));
accumulate(await processLocalExtensionsDir(PROJECT_EXTENSIONS_DIR, `project:${PROJECT_EXTENSIONS_DIR}`));

const totalMs = performance.now() - t0;
console.log(
	`\nTotal: ${CLEAN ? `cleaned=${totalCleaned}` : `compiled=${totalCompiled} skipped=${totalSkipped}`} in ${totalMs.toFixed(0)}ms`,
);
