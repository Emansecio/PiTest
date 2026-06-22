/**
 * Project config → system-prompt context.
 *
 * The model follows lint/TS conventions only when an AGENTS.md spells them out
 * by hand. Repos without that file get code generated "blind": the first write
 * passes locally then fails `npm run check` on rules the model never saw
 * (verbatim-module-syntax, quote style, indent width, strict-null creep).
 *
 * This reads the project's own `tsconfig.json` and `biome.json` (the source of
 * truth the check command enforces) and distills the few fields that actually
 * change generated code into a compact `<project_config>` block. Best-effort by
 * construction: any parse/read failure yields no block rather than throwing, so
 * a malformed config never blocks a session.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Strip `//` and block comments so JSONC configs (tsconfig, biome) parse.
 * String-aware: a regex approach would eat the comment-open sequence embedded
 * in path globs (e.g. an alias value like "@pit" followed by a slash-star) and
 * corrupt the JSON, so this walks the text and only treats `//` and block
 * comments as comments when outside a string.
 */
function stripJsonComments(text: string): string {
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			if (i < text.length) out += "\n";
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++; // skip the closing '/'
			continue;
		}
		out += ch;
	}
	return out;
}

function readJsonc(path: string): Record<string, unknown> | null {
	try {
		const raw = readFileSync(path, "utf-8");
		// Fast path: well-formed JSON (no comments) parses directly, avoiding the
		// scanner entirely. Only strip when a first parse fails.
		try {
			return JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
		}
	} catch {
		return null;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Normalize an `extends` target to an absolute tsconfig path, or undefined for a bare specifier we can't resolve cheaply. */
function resolveExtendsPath(spec: string, fromDir: string): string | undefined {
	// Only relative / absolute paths are resolved here; bare package specifiers
	// (@tsconfig/node20, some-pkg/tsconfig) would need node module resolution and
	// rarely carry erasableSyntaxOnly — skip them (best-effort, fail-open).
	if (!spec.startsWith(".") && !isAbsolute(spec)) return undefined;
	const base = isAbsolute(spec) ? spec : resolve(fromDir, spec);
	return base.endsWith(".json") ? base : `${base}.json`;
}

/**
 * Read `cwd/tsconfig.json` and merge its `compilerOptions` with those inherited
 * through the `extends` chain (child overrides parent). Strict flags like
 * `erasableSyntaxOnly` commonly live in a shared base config, so reading only the
 * leaf would miss them. Bounded depth + a visited set guard against cycles.
 * Best-effort: any unreadable link contributes nothing.
 */
function loadMergedCompilerOptions(cwd: string): Record<string, unknown> | undefined {
	const root = join(cwd, "tsconfig.json");
	if (!existsSync(root)) return undefined;

	const visited = new Set<string>();
	const merge = (absPath: string, depth: number): Record<string, unknown> | undefined => {
		if (depth > 8 || visited.has(absPath)) return undefined;
		visited.add(absPath);
		const json = readJsonc(absPath);
		if (!json) return undefined;
		const own = asRecord(json.compilerOptions) ?? {};

		// Resolve parents first (one or many), then let `own` override them.
		let inherited: Record<string, unknown> = {};
		const ext = json.extends;
		const specs =
			typeof ext === "string" ? [ext] : Array.isArray(ext) ? ext.filter((s) => typeof s === "string") : [];
		for (const spec of specs) {
			const parentPath = resolveExtendsPath(spec as string, dirname(absPath));
			if (!parentPath) continue;
			const parentCo = merge(parentPath, depth + 1);
			if (parentCo) inherited = { ...inherited, ...parentCo };
		}
		return { ...inherited, ...own };
	};

	const merged = merge(root, 0);
	return merged && Object.keys(merged).length > 0 ? merged : undefined;
}

/** A resolved tsconfig `paths`/`baseUrl` mapping (absolute baseUrl). */
export interface TsconfigPathsResult {
	baseUrl: string;
	paths: Record<string, string[]>;
}

/** Coerce a raw `compilerOptions.paths` value to `Record<string, string[]>`, or undefined when empty/invalid. */
function normalizeTsPaths(raw: unknown): Record<string, string[]> | undefined {
	const record = asRecord(raw);
	if (!record) return undefined;
	const out: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(record)) {
		if (!Array.isArray(value)) continue;
		const targets = value.filter((target): target is string => typeof target === "string" && target.length > 0);
		if (targets.length > 0) out[key] = targets;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve the first `paths` mapping reachable from `absPath` (its own, else its
 * `extends` chain), with `baseUrl` resolved against the config that DEFINES the
 * paths (TS semantics). Bounded depth + visited set guard against cycles.
 */
function resolvePathsFromConfig(absPath: string, depth: number, visited: Set<string>): TsconfigPathsResult | undefined {
	if (depth > 8 || visited.has(absPath)) return undefined;
	visited.add(absPath);
	const json = readJsonc(absPath);
	if (!json) return undefined;
	const configDir = dirname(absPath);
	const co = asRecord(json.compilerOptions);
	if (co) {
		const paths = normalizeTsPaths(co.paths);
		if (paths) {
			const baseUrl = typeof co.baseUrl === "string" ? resolve(configDir, co.baseUrl) : configDir;
			return { baseUrl, paths };
		}
	}
	const ext = json.extends;
	let specs: string[] = [];
	if (typeof ext === "string") specs = [ext];
	else if (Array.isArray(ext)) specs = ext.filter((s): s is string => typeof s === "string");
	for (const spec of specs) {
		const parentPath = resolveExtendsPath(spec, configDir);
		if (!parentPath) continue;
		const found = resolvePathsFromConfig(parentPath, depth + 1, visited);
		if (found) return found;
	}
	return undefined;
}

/**
 * Resolve the tsconfig/jsconfig `paths` mapping that governs `targetFile`: walk up
 * from its directory to the NEAREST config, then take the first `paths` found
 * through that config's `extends` chain. The nearest config is authoritative — if
 * it maps no paths, aliases are not grounded here (return undefined -> caller
 * ALLOWs). Best-effort / fail-open: any unreadable link yields undefined.
 */
export function findTsconfigPathsForFile(targetFile: string): TsconfigPathsResult | undefined {
	if (typeof targetFile !== "string" || targetFile.length === 0) return undefined;
	let dir = dirname(resolve(targetFile));
	for (;;) {
		for (const name of ["tsconfig.json", "jsconfig.json"]) {
			const file = join(dir, name);
			if (existsSync(file)) return resolvePathsFromConfig(file, 0, new Set());
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function summarizeTsconfig(cwd: string): string[] {
	const co = loadMergedCompilerOptions(cwd);
	if (!co) return [];

	const flags: string[] = [];
	if (co.strict === true) flags.push("strict");
	if (co.noImplicitAny === true || (co.strict === true && co.noImplicitAny !== false)) flags.push("no implicit any");
	if (co.verbatimModuleSyntax === true) flags.push("verbatimModuleSyntax (use `import type` for type-only imports)");
	if (co.erasableSyntaxOnly === true)
		flags.push("erasableSyntaxOnly (NO enums, namespaces, parameter properties, or other emit-bearing TS syntax)");
	if (co.exactOptionalPropertyTypes === true) flags.push("exactOptionalPropertyTypes");
	if (co.noUncheckedIndexedAccess === true) flags.push("noUncheckedIndexedAccess");

	const lines: string[] = [];
	if (flags.length > 0) lines.push(`TypeScript: ${flags.join("; ")}.`);

	const paths = asRecord(co.paths);
	if (paths) {
		const aliases = Object.keys(paths).slice(0, 12).join(", ");
		if (aliases.length > 0) lines.push(`Path aliases: ${aliases}.`);
	}
	return lines;
}

function summarizeBiome(cwd: string): string[] {
	const path = ["biome.json", "biome.jsonc"].map((f) => join(cwd, f)).find((p) => existsSync(p));
	if (!path) return [];
	const json = readJsonc(path);
	if (!json) return [];

	const lines: string[] = [];
	const formatter = asRecord(json.formatter);
	const jsFormatter = asRecord(asRecord(json.javascript)?.formatter);
	const fmtParts: string[] = [];
	const indentStyle = formatter?.indentStyle;
	if (indentStyle === "tab") fmtParts.push("tab indent");
	else if (indentStyle === "space") fmtParts.push(`${formatter?.indentWidth ?? 2}-space indent`);
	if (typeof formatter?.lineWidth === "number") fmtParts.push(`line width ${formatter.lineWidth}`);
	const quoteStyle = jsFormatter?.quoteStyle;
	if (quoteStyle === "single") fmtParts.push("single quotes");
	else if (quoteStyle === "double") fmtParts.push("double quotes");
	const semicolons = jsFormatter?.semicolons;
	if (semicolons === "always") fmtParts.push("semicolons required");
	else if (semicolons === "asNeeded") fmtParts.push("semicolons as-needed");
	if (fmtParts.length > 0) lines.push(`Biome format: ${fmtParts.join(", ")}.`);

	return lines;
}

/**
 * Does this project's tsconfig enforce `erasableSyntaxOnly`? When true, the
 * compiler (or Node's native type-stripping) rejects emit-bearing TS syntax —
 * enums, namespaces/modules with a body, and constructor parameter properties.
 * Used to GATE the erasable-syntax write/edit preflight: the guard only fires
 * where the project's own check command would reject the construct, so it never
 * mis-fires on a project that legitimately allows enums. Best-effort: any
 * read/parse failure returns false (guard stays off).
 */
export function projectEnforcesErasableSyntax(cwd: string): boolean {
	try {
		return loadMergedCompilerOptions(cwd)?.erasableSyntaxOnly === true;
	} catch {
		return false;
	}
}

/**
 * Does this project's biome config enforce `noNestedTernary`? Used to GATE the
 * nested-ternary half of the TS preflight, so it stays silent on any project that
 * allows nested ternaries. A rule is active when the linter is on and the rule is
 * not explicitly "off"; absent-but-recommended counts (noNestedTernary ships in
 * Biome 2.x's recommended set, on by default). Best-effort: any failure → false.
 */
export function projectEnforcesNoNestedTernary(cwd: string): boolean {
	try {
		const path = ["biome.json", "biome.jsonc"].map((f) => join(cwd, f)).find((p) => existsSync(p));
		if (!path) return false;
		const json = readJsonc(path);
		if (!json) return false;
		const linter = asRecord(json.linter);
		if (linter?.enabled === false) return false;
		const rules = asRecord(linter?.rules);
		const rule = asRecord(rules?.style)?.noNestedTernary;
		if (rule === "off") return false;
		if (rule !== undefined) return true; // "error" | "warn" | { level: ... }
		// Not set explicitly → inherited from the recommended set unless disabled.
		return rules?.recommended !== false;
	} catch {
		return false;
	}
}

/**
 * Build a synthetic context-file entry describing the project's enforced
 * TS/lint conventions, or null when nothing useful could be read. The returned
 * shape matches `loadProjectContextFiles` entries so it slots into the existing
 * `<project_context>` rendering without special-casing.
 */
export function loadProjectConfigContext(cwd: string): { path: string; content: string } | null {
	const lines = [...summarizeTsconfig(cwd), ...summarizeBiome(cwd)];
	if (lines.length === 0) return null;
	const content = `Conventions enforced by this project's check command — match them when writing or editing code so the first attempt passes:\n${lines
		.map((l) => `- ${l}`)
		.join("\n")}`;
	return { path: "<project-config>", content };
}
