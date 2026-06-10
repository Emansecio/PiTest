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
import { join } from "node:path";

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

function summarizeTsconfig(cwd: string): string[] {
	const path = join(cwd, "tsconfig.json");
	if (!existsSync(path)) return [];
	const json = readJsonc(path);
	const co = asRecord(json?.compilerOptions);
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
