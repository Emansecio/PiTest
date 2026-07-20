/**
 * Repo Graph — npm workspace package map (package name -> repo-relative dir).
 *
 * `edges.ts` used to GUESS the workspace layout: `@pit/<name>` ->
 * `packages/<name>/src/index`. That guess silently misses every workspace whose
 * directory doesn't match its published name — `@pit/agent-core` lives in
 * `packages/agent`, so every cross-package edge INTO the agent runtime was
 * invisible to the graph. This module reads the truth instead of guessing: the
 * root manifest's `workspaces` field (both the array form and the
 * `{ packages: [...] }` form), each glob expanded ONE level against an injected
 * readdir, and each candidate directory's own `package.json#name` mapped to its
 * repo-relative (forward-slash) directory.
 *
 * Deliberately narrow, matching its single caller (living-index's reindex pass):
 *   - Only trivial one-level globs (`packages/*`) and literal dirs
 *     (`packages/coding-agent/examples/extensions/with-deps`) are expanded; any
 *     other glob shape (`**`, mid-pattern `*`) is SKIPPED, not half-guessed.
 *   - NO caching here by design: the caller builds the map at most once per
 *     reindex pass; a process-global cache would go stale the moment a workspace
 *     is added mid-session, for a saving that doesn't matter at once-per-pass.
 *   - Fail-open by construction: any read/parse failure yields an empty map (or
 *     skips the one bad candidate) — a malformed manifest can never break a
 *     reindex pass, mirroring `edges.ts`'s "unresolved is silently dropped".
 *
 * I/O is injected (`WorkspaceMapDeps`) in the same style as living-index's deps
 * surface, with real `node:fs` defaults, so tests drive exact filesystems.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Injectable I/O surface. Both fields have real defaults; tests override. */
export interface WorkspaceMapDeps {
	/** Read a file's text, or null when unreadable/absent. */
	readFile: (absPath: string) => string | null;
	/** List a directory's entry names, or null when unreadable/absent. */
	readDir: (absPath: string) => string[] | null;
}

export const defaultWorkspaceMapDeps: WorkspaceMapDeps = {
	readFile: (absPath) => {
		try {
			return readFileSync(absPath, "utf8");
		} catch {
			return null;
		}
	},
	readDir: (absPath) => {
		try {
			return readdirSync(absPath);
		} catch {
			return null;
		}
	},
};

/** Parse JSON to a plain object, or null (fail-open) on any malformation. */
function parseJsonObject(raw: string | null): Record<string, unknown> | null {
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** The `workspaces` globs: array form, or the `{ packages: [...] }` object form. */
function workspacePatterns(pkg: Record<string, unknown>): string[] {
	const ws = pkg.workspaces;
	if (Array.isArray(ws)) return ws.filter((p): p is string => typeof p === "string");
	if (ws !== null && typeof ws === "object") {
		const packages = (ws as { packages?: unknown }).packages;
		if (Array.isArray(packages)) return packages.filter((p): p is string => typeof p === "string");
	}
	return [];
}

/**
 * Expand one workspace pattern to candidate repo-relative dirs. Only the trivial
 * shapes are handled — a literal dir (no `*`) passes through as-is; a one-level
 * trailing glob (`packages/*`) expands via the injected readdir (entries that are
 * plain files are harmless: their `<entry>/package.json` read below just fails).
 * Anything else (negations, `**`, mid-pattern `*`, absolute/escaping paths) is
 * skipped: an unexpanded pattern must never invent a wrong mapping.
 */
function expandPattern(cwd: string, rawPattern: string, deps: WorkspaceMapDeps): string[] {
	const pattern = rawPattern.replace(/\/+$/, "");
	if (pattern.length === 0 || pattern.startsWith("!") || pattern.startsWith("..") || pattern.startsWith("/")) {
		return [];
	}
	if (!pattern.includes("*")) return [pattern];
	if (!pattern.endsWith("/*") || pattern.indexOf("*") !== pattern.length - 1) return [];
	const base = pattern.slice(0, -2);
	if (base.length === 0 || base.includes("*")) return [];
	const entries = deps.readDir(join(cwd, base));
	if (entries === null) return [];
	return entries.filter((e) => !e.startsWith(".")).map((e) => `${base}/${e}`);
}

/**
 * Build the workspace package map for the monorepo rooted at `cwd`: package name
 * (`package.json#name`) -> repo-relative forward-slash directory (e.g.
 * `@pit/agent-core` -> `packages/agent`). Empty map when `cwd` has no manifest,
 * declares no workspaces, or anything fails to read/parse (fail-open). On a
 * duplicate name the FIRST declaration wins (deterministic; npm itself rejects
 * duplicate workspace names, so this only matters for malformed trees).
 */
export function buildWorkspacePackageMap(
	cwd: string,
	deps: WorkspaceMapDeps = defaultWorkspaceMapDeps,
): Map<string, string> {
	const map = new Map<string, string>();
	try {
		const rootPkg = parseJsonObject(deps.readFile(join(cwd, "package.json")));
		if (rootPkg === null) return map;
		for (const pattern of workspacePatterns(rootPkg)) {
			for (const dir of expandPattern(cwd, pattern, deps)) {
				const pkg = parseJsonObject(deps.readFile(join(cwd, dir, "package.json")));
				const name = pkg?.name;
				if (typeof name !== "string" || name.length === 0) continue;
				if (!map.has(name)) map.set(name, dir);
			}
		}
		return map;
	} catch {
		return new Map();
	}
}
