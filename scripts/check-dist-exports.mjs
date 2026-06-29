// Guard against stale package dist/ barrels.
//
// Workspace packages resolve @pit/* imports to dist/index.js at runtime (tsx
// still loads dist for dependencies). A new export in src/index.ts that never
// got rebuilt into dist/ surfaces as a runtime SyntaxError — e.g.
// VirtualizedContainer missing from @pit/tui.
//
// Compares value exports and export * paths between src/index.ts and
// dist/index.js for every workspace package whose main export points at dist.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** @type {Array<{ name: string; dir: string }>} */
const PACKAGES = [
	{ name: "@pit/tui", dir: "packages/tui" },
	{ name: "@pit/ai", dir: "packages/ai" },
	{ name: "@pit/agent-core", dir: "packages/agent" },
	{ name: "@pit/coding-agent", dir: "packages/coding-agent" },
];

/**
 * @param {string} text
 */
function stripComments(text) {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/[^\n]*/g, "");
}

/**
 * @param {string} source
 * @param {number} openBraceIndex index of '{'
 */
function findMatchingBrace(source, openBraceIndex) {
	let depth = 0;
	for (let i = openBraceIndex; i < source.length; i++) {
		const ch = source[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * @param {string} inner
 * @returns {string[]}
 */
function parseNamedExportSpecs(inner) {
	const specs = [];
	let current = "";
	let depth = 0;
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (ch === "{" || ch === "(" || ch === "<") depth++;
		else if (ch === "}" || ch === ")" || ch === ">") depth--;
		else if (ch === "," && depth === 0) {
			specs.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim()) specs.push(current);
	return specs;
}

/**
 * @param {string} spec
 * @returns {string | null}
 */
function valueExportNameFromSpec(spec) {
	const trimmed = spec.trim();
	if (!trimmed || trimmed.startsWith("type ")) return null;
	const asMatch = trimmed.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
	if (asMatch) return asMatch[2];
	const id = trimmed.match(/^[\w$]+/)?.[0];
	return id ?? null;
}

/**
 * @param {string} text
 * @returns {{ valueExports: Set<string>; starExports: Set<string> }}
 */
function parseIndexExports(text) {
	const cleaned = stripComments(text);
	const valueExports = new Set();
	const starExports = new Set();

	let i = 0;
	while (i < cleaned.length) {
		const exportAt = cleaned.indexOf("export", i);
		if (exportAt === -1) break;
		let pos = exportAt + 6;
		while (pos < cleaned.length && /\s/.test(cleaned[pos])) pos++;

		if (cleaned.startsWith("type", pos)) {
			const afterType = pos + 4;
			if (/\s/.test(cleaned[afterType] ?? "")) {
				let typePos = afterType;
				while (typePos < cleaned.length && /\s/.test(cleaned[typePos])) typePos++;
				if (cleaned[typePos] === "{") {
					const close = findMatchingBrace(cleaned, typePos);
					i = close === -1 ? cleaned.length : close + 1;
					continue;
				}
				// export type Foo = ... — skip to end of statement
				const semi = cleaned.indexOf(";", typePos);
				i = semi === -1 ? cleaned.length : semi + 1;
				continue;
			}
		}

		if (cleaned[pos] === "*") {
			const fromMatch = cleaned.slice(pos).match(/^\*\s+from\s+['"]([^'"]+)['"]/);
			if (fromMatch) starExports.add(fromMatch[1]);
			const semi = cleaned.indexOf(";", pos);
			i = semi === -1 ? cleaned.length : semi + 1;
			continue;
		}

		if (cleaned[pos] === "{") {
			const close = findMatchingBrace(cleaned, pos);
			if (close === -1) {
				i = pos + 1;
				continue;
			}
			const inner = cleaned.slice(pos + 1, close);
			for (const spec of parseNamedExportSpecs(inner)) {
				const name = valueExportNameFromSpec(spec);
				if (name) valueExports.add(name);
			}
			i = close + 1;
			continue;
		}

		const declMatch = cleaned.slice(exportAt).match(
			/^export\s+(?:declare\s+)?(?:async\s+)?(?:class|function|const|let|var)\s+([\w$]+)/,
		);
		if (declMatch) {
			valueExports.add(declMatch[1]);
			const semi = cleaned.indexOf(";", exportAt);
			i = semi === -1 ? cleaned.length : semi + 1;
			continue;
		}

		i = exportAt + 6;
	}

	return { valueExports, starExports };
}

/**
 * @param {string} tsPath
 */
function tsPathToDistJs(tsPath) {
	return tsPath.replace(/\.ts$/, ".js");
}

/**
 * @param {string} pkgDir relative to repo root
 */
function checkPackage({ name, dir }) {
	const srcPath = join(REPO_ROOT, dir, "src", "index.ts");
	const distPath = join(REPO_ROOT, dir, "dist", "index.js");
	const errors = [];

	if (!existsSync(srcPath)) return errors;
	if (!existsSync(distPath)) {
		errors.push(`${name}: missing dist/index.js — run: npm run build -w ${name}`);
		return errors;
	}

	const src = readFileSync(srcPath, "utf-8");
	const dist = readFileSync(distPath, "utf-8");
	const srcParsed = parseIndexExports(src);
	const distParsed = parseIndexExports(dist);

	for (const valueName of srcParsed.valueExports) {
		if (!distParsed.valueExports.has(valueName)) {
			errors.push(`${name}: dist/index.js missing value export "${valueName}"`);
		}
	}

	for (const starPath of srcParsed.starExports) {
		const distPathExpected = tsPathToDistJs(starPath);
		if (!distParsed.starExports.has(distPathExpected)) {
			errors.push(`${name}: dist/index.js missing \`export * from '${distPathExpected}'\``);
		}
	}

	return errors;
}

const allErrors = [];
for (const pkg of PACKAGES) {
	allErrors.push(...checkPackage(pkg));
}

if (allErrors.length > 0) {
	console.error("dist-exports: src/index.ts and dist/index.js are out of sync:");
	for (const err of allErrors) console.error(`  ${err}`);
	console.error("  Fix: npm run build -w <package>  (or npm run build at repo root)");
	process.exit(1);
}

console.log(`dist-exports: ok (${PACKAGES.length} packages)`);