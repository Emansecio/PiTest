/**
 * Git branch detection for the system prompt's dynamic suffix.
 *
 * Deliberately subprocess-free: a `git status` child per session boot proved
 * hazardous on Windows (the child holds cwd until exit — EBUSY on rmdir in
 * tests and short-lived `pit -p` runs, plus spawn contention in the parallel
 * suite). Reading `.git/HEAD` directly is ~free, needs no abort/dispose
 * plumbing, and can run on every system-prompt rebuild so the branch stays
 * fresh after a mid-session checkout.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read the current branch from `.git/HEAD`. Handles worktrees/submodules
 * (`.git` as a `gitdir:` pointer file). Returns the short commit hash for a
 * detached HEAD, or `undefined` outside a repo / on any read failure.
 */
export function readGitBranch(cwd: string): string | undefined {
	let gitDir = join(cwd, ".git");
	try {
		// Worktree/submodule: `.git` is a file containing "gitdir: <path>".
		// readFileSync on a directory throws (EISDIR), which we swallow and
		// keep the directory path.
		const pointer = readFileSync(gitDir, "utf-8");
		const match = pointer.match(/^gitdir:\s*(.+)\s*$/m);
		if (match) {
			const target = match[1]!.trim();
			gitDir = target.startsWith("/") || /^[A-Za-z]:/.test(target) ? target : join(cwd, target);
		}
	} catch {
		// `.git` is a directory (the common case) or missing — handled below.
	}
	let head: string;
	try {
		head = readFileSync(join(gitDir, "HEAD"), "utf-8").trim();
	} catch {
		return undefined;
	}
	const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/);
	if (refMatch) {
		return refMatch[1]!.trim();
	}
	// Detached HEAD: the file holds a raw commit hash.
	if (/^[0-9a-f]{40}$/.test(head)) {
		return `detached @ ${head.slice(0, 12)}`;
	}
	return undefined;
}
