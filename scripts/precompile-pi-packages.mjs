#!/usr/bin/env node
/**
 * Pre-compile TypeScript sources of installed pi packages to JavaScript,
 * so the loader can skip jiti transpilation on every startup.
 *
 * What it does:
 *   1. Walks ~/.pi/agent/npm/node_modules for pi packages
 *      (those with "pi" or "pi-extension" keyword, OR a `pi` field in package.json)
 *   2. Reads package.json#pi.extensions (list of dirs/files relative to package root)
 *   3. For each .ts file in those paths, emits a sibling .js via esbuild
 *   4. Skips packages that already ship .js (dist-style)
 *
 * Safe to re-run. Pass --force to overwrite existing .js outputs.
 * Pass --clean to delete generated .js files instead.
 */

import { build } from "esbuild";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const FORCE = process.argv.includes("--force");
const CLEAN = process.argv.includes("--clean");
const VERBOSE = process.argv.includes("--verbose");

// Respect PI_CODING_AGENT_DIR (and PI_NPM_DIR override) so this script
// works regardless of where the user's pi agent dir lives.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR
	? process.env.PI_CODING_AGENT_DIR.replace(/^~(?=$|\/|\\)/, homedir())
	: join(homedir(), ".pi", "agent");
const NPM_DIR = process.env.PI_NPM_DIR ?? join(AGENT_DIR, "npm", "node_modules");

if (!existsSync(NPM_DIR)) {
	console.error(`Pi npm dir not found: ${NPM_DIR}`);
	process.exit(1);
}

/** Find pi packages (those with a `pi` field in package.json). */
function findPiPackages(root) {
	const found = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, entry.name);
		if (entry.name.startsWith("@")) {
			// Scoped: iterate inner directories
			for (const inner of readdirSync(dir, { withFileTypes: true })) {
				if (!inner.isDirectory()) continue;
				const innerDir = join(dir, inner.name);
				const pkg = readPkg(innerDir);
				if (pkg?.pi) found.push({ dir: innerDir, pkg });
			}
		} else {
			const pkg = readPkg(dir);
			if (pkg?.pi) found.push({ dir, pkg });
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

/** Collect all .ts files under a path (relative to package root). */
function collectTsFiles(packageDir, relativePath) {
	const target = resolve(packageDir, relativePath);
	if (!existsSync(target)) return [];
	const stat = statSync(target);
	if (stat.isFile()) {
		return target.endsWith(".ts") && !target.endsWith(".d.ts") ? [target] : [];
	}
	const out = [];
	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name === "node_modules" || e.name === "dist") continue;
				walk(p);
			} else if (e.isFile() && p.endsWith(".ts") && !p.endsWith(".d.ts")) {
				out.push(p);
			}
		}
	};
	walk(target);
	return out;
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
		.replace(/(from\s*["'])(\.{1,2}\/[^"']+?)\.tsx?(["'])/g, '$1$2.js$3')
		// import("./x.ts")
		.replace(/(import\(\s*["'])(\.{1,2}\/[^"']+?)\.tsx?(["']\s*\))/g, '$1$2.js$3')
		// export ... from "./x.ts"
		.replace(/(export\s*(?:\*|\{[^}]*\})\s*from\s*["'])(\.{1,2}\/[^"']+?)\.tsx?(["'])/g, '$1$2.js$3');
	// Rewrite legacy @mariozechner/* aliases to the canonical @earendil-works/*
	// scope so Node ESM resolves them via node_modules without needing the
	// pi-coding-agent jiti alias map.
	rewritten = rewritten.replace(/@mariozechner\/pi-/g, "@earendil-works/pi-");
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
	if (allTs.length === 0) {
		return { name: pkg.name, files: 0, skipped: 0, ms: 0 };
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
				if (VERBOSE) console.log(`  + ${relative(dir, r.jsPath)}`);
			}
		}
	}
	const ms = performance.now() - start;
	return { name: pkg.name, files: compiled, skipped, cleaned, ms };
}

const t0 = performance.now();
const packages = findPiPackages(NPM_DIR);
console.log(`${CLEAN ? "Cleaning" : "Pre-compiling"} ${packages.length} pi packages from ${NPM_DIR}\n`);

let totalCompiled = 0;
let totalSkipped = 0;
let totalCleaned = 0;
for (const p of packages) {
	const r = await processPackage(p);
	if (r.files === 0 && r.skipped === 0 && !r.cleaned) continue;
	totalCompiled += r.files ?? 0;
	totalSkipped += r.skipped ?? 0;
	totalCleaned += r.cleaned ?? 0;
	const tag = CLEAN ? `cleaned=${r.cleaned}` : `compiled=${r.files} skipped=${r.skipped}`;
	console.log(`  ${r.name.padEnd(40)} ${tag} (${r.ms.toFixed(0)}ms)`);
}

const totalMs = performance.now() - t0;
console.log(`\nTotal: ${CLEAN ? `cleaned=${totalCleaned}` : `compiled=${totalCompiled} skipped=${totalSkipped}`} in ${totalMs.toFixed(0)}ms`);
