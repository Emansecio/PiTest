/**
 * Built-in subtree-context extension (P1-4, `docs/proposals/2026-07-31-revisao-harness.md`).
 *
 * Boot loads AGENTS.md/CLAUDE.md from the agent dir plus the ANCESTOR chain of
 * `cwd` (`loadProjectContextFiles` in `../resource-loader.ts` walks UP to the
 * filesystem root). Nothing loads — or even points at — a
 * `packages/foo/AGENTS.md` when the session starts at the monorepo root and the
 * model then works inside that package: the per-package rules are invisible
 * unless the model happens to stumble on the file.
 *
 * This closes that hole from the other direction: when a file tool touches a
 * path BELOW `cwd`, every directory between `cwd` (exclusive) and the target
 * (inclusive, so an `ast_edit` whose `path` names a directory still sees its
 * OWN rules) is probed for an AGENTS.md. The first time one is found its
 * content is appended to that tool's result — the same idiomatic mid-turn
 * injection channel `patch-audit-extension.ts` / `impact-extension.ts` use
 * (append a text block to `tool_result.content`); no new channel, no system
 * prompt rewrite. Ancestors are deliberately NOT walked: boot already covers
 * them.
 *
 * Budget discipline mirrors the boot path (`../context-files.ts`):
 *  - E6 per-file cap: a file over `PROJECT_CONTEXT_INLINE_MAX_CHARS` is injected
 *    as a head+tail excerpt with a `read({path})` pointer
 *    (`applyContextRetrievalMode`, the exact function the boot block uses).
 *  - M25a aggregate cap, session-scoped: once the running total of injected
 *    chars would pass `PROJECT_CONTEXT_AGGREGATE_MAX_CHARS`, further files are
 *    reduced to the same 1-line read-pointer (`formatAggregatePointer`) instead
 *    of being inlined — the model can still load them on demand.
 * Both caps are unconditional here: `PIT_NO_CONTEXT_RETRIEVAL` opts the BOOT
 * block out of excerpting (a one-time, measurable prefix cost), but this channel
 * fires mid-turn on arbitrary paths, where an uncapped inline would be unbounded.
 * `PIT_NO_SUBTREE_CONTEXT` is the escape hatch for this mechanism.
 *
 * Dedupe is permanent per session (canonical path keys, same
 * `canonicalPathKey` canonicalization the read-guard uses) and is ALSO seeded
 * from the boot-loaded context files (`getLoadedContextPaths`, wired to
 * `ResourceLoader.getAgentsFiles()`), so a file already in `<project_context>`
 * is never injected twice.
 *
 * Cost control: directory probes go through a 2s TTL cache (same shape as
 * `path-grounding-extension.ts`'s fs cache), so a burst of tool calls in one
 * subtree pays one stat per directory, not one per call. Negative results are
 * cached too — the common case is "no AGENTS.md here".
 *
 * Fail-open by construction: any throw degrades to "inject nothing" and the
 * tool result passes through untouched. Kill-switch `PIT_NO_SUBTREE_CONTEXT`.
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { recordDiagnostic } from "@pit/ai";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import {
	applyContextRetrievalMode,
	formatAggregatePointer,
	PROJECT_CONTEXT_AGGREGATE_MAX_CHARS,
} from "../context-files.ts";
import type { ExtensionAPI } from "../extensions/index.js";
import { extractPathArg, resolveToolPath } from "../tools/argument-prep.ts";
import { canonicalPathKey } from "../tools/path-utils.ts";

/** TTL for the per-directory AGENTS.md probe cache (ms) — mirrors PATH_GROUNDING_FS_CACHE_TTL_MS. */
export const SUBTREE_CONTEXT_FS_CACHE_TTL_MS = 2000;

/**
 * Safety rail on how far below `cwd` we walk. A pathological path (or a
 * symlink loop resolved into a very deep chain) must not turn one tool call
 * into an unbounded stat storm.
 */
const MAX_SUBTREE_DEPTH = 16;

/** Candidate basenames, in probe order — same list (AGENTS.md only) the boot loader treats as canonical. */
const AGENTS_BASENAMES = ["AGENTS.md", "AGENTS.MD"] as const;

/** File tools whose `path` argument anchors the model in a subtree. */
const TRIGGER_TOOLS = new Set(["read", "edit", "edit_v2", "write", "ast_edit"]);

export function isSubtreeContextDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_NO_SUBTREE_CONTEXT);
}

export interface SubtreeContextOptions {
	cwd: string;
	/**
	 * Paths of the context files already loaded at boot (agent dir + cwd +
	 * ancestors + legacy rule files). Seeds the dedupe set so a file already
	 * inlined in `<project_context>` is never re-injected. Resolved lazily — the
	 * resource loader has not run yet when extensions are bundled.
	 */
	getLoadedContextPaths?: () => readonly string[];
	/** Injected for tests. Returns undefined for a missing/unreadable file. */
	readContextFile?: (absPath: string) => string | undefined;
}

function defaultReadContextFile(absPath: string): string | undefined {
	try {
		return readFileSync(absPath, "utf-8");
	} catch {
		return undefined;
	}
}

/** Repo-relative, forward-slash path for display (falls back to the absolute path outside cwd). */
function toDisplayPath(cwd: string, absPath: string): string {
	const rel = relative(resolve(cwd), resolve(absPath));
	if (!rel || rel.startsWith("..")) return absPath.split("\\").join("/");
	return rel.split("\\").join("/");
}

/**
 * Directories to probe for a target path, ordered OUTERMOST first so the most
 * specific rules land last (closest to the model's attention). `cwd` itself is
 * excluded — boot already loaded it. The target is included as its own
 * candidate directory: harmless for a file (`foo.ts/AGENTS.md` never exists)
 * and correct for an `ast_edit` whose `path` names a directory.
 */
export function subtreeDirsBetween(cwd: string, absTarget: string): string[] {
	const root = resolve(cwd);
	const dirs: string[] = [];
	let current = resolve(absTarget);
	for (let depth = 0; depth < MAX_SUBTREE_DEPTH; depth++) {
		if (current === root) return dirs.reverse();
		const parent = dirname(current);
		// Filesystem root reached without crossing cwd → the target is not under
		// cwd (absolute path elsewhere, or `../` escape). Nothing to inject.
		if (parent === current) return [];
		dirs.push(current);
		current = parent;
	}
	return [];
}

export function createSubtreeContextExtension(options: SubtreeContextOptions) {
	return (pi: ExtensionAPI) => {
		if (isSubtreeContextDisabled()) return;
		const readContextFile = options.readContextFile ?? defaultReadContextFile;

		/** Canonical keys already injected — or already loaded at boot. Permanent for the session. */
		const seen = new Set<string>();
		let bootSeeded = false;
		/** Running total of injected chars (post-E6), against the M25a aggregate cap. */
		let injectedChars = 0;
		/** dir -> probe result, short TTL. Negative results cached too (the common case). */
		const probeCache = new Map<string, { at: number; value: { path: string; content: string } | undefined }>();

		function seedFromBoot(): void {
			if (bootSeeded) return;
			bootSeeded = true;
			for (const path of options.getLoadedContextPaths?.() ?? []) {
				seen.add(canonicalPathKey(resolve(path)));
			}
		}

		function probeDir(dir: string): { path: string; content: string } | undefined {
			const now = Date.now();
			const hit = probeCache.get(dir);
			if (hit && now - hit.at < SUBTREE_CONTEXT_FS_CACHE_TTL_MS) return hit.value;
			let value: { path: string; content: string } | undefined;
			for (const basename of AGENTS_BASENAMES) {
				const filePath = join(dir, basename);
				const content = readContextFile(filePath);
				if (content !== undefined) {
					value = { path: filePath, content };
					break;
				}
			}
			probeCache.set(dir, { at: now, value });
			return value;
		}

		/** E6 excerpt, then the session-scoped M25a aggregate cap. */
		function budgetedContent(file: { path: string; content: string }): string {
			const [excerpted] = applyContextRetrievalMode([file], options.cwd);
			const text = excerpted.content;
			if (injectedChars + text.length > PROJECT_CONTEXT_AGGREGATE_MAX_CHARS) {
				return formatAggregatePointer(file, options.cwd);
			}
			injectedChars += text.length;
			return text;
		}

		pi.on("tool_result", (event) => {
			try {
				if (isSubtreeContextDisabled()) return undefined;
				if (!TRIGGER_TOOLS.has(event.toolName)) return undefined;

				const rawPath = extractPathArg(event.input as Record<string, unknown>);
				if (rawPath === undefined) return undefined;
				const absTarget = resolveToolPath(rawPath, options.cwd);

				const blocks: string[] = [];
				for (const dir of subtreeDirsBetween(options.cwd, absTarget)) {
					const file = probeDir(dir);
					if (!file) continue;
					seedFromBoot();
					const key = canonicalPathKey(file.path);
					if (seen.has(key)) continue;
					seen.add(key);

					const display = toDisplayPath(options.cwd, file.path);
					blocks.push(
						`<project_instructions path="${display}" scope="subtree">\n${budgetedContent(file)}\n</project_instructions>`,
					);
					recordDiagnostic({
						// Existing category for context conditioning — no new
						// DiagnosticCategory needed; `ruleId` names this producer.
						category: "conditioning.context",
						level: "info",
						source: "subtree-context-extension",
						context: {
							path: file.path,
							ruleId: "subtree-agents-injected",
							note: `${file.content.length} chars`,
						},
					});
				}
				if (blocks.length === 0) return undefined;

				const header = `Subtree rules apply to this path (not loaded at startup — only ancestors of cwd are):`;
				return {
					content: [...event.content, { type: "text" as const, text: `${header}\n${blocks.join("\n")}` }],
				};
			} catch {
				// Fail-open: an injection bug must never corrupt a tool result.
				return undefined;
			}
		});
	};
}
