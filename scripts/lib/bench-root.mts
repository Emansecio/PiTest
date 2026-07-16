/**
 * DX-02 — stable measurement root for the token-economy benches.
 *
 * The benches embed the measured cwd into the synthetic system prompt (and
 * into synthetic paths like `.pit/memory/MEMORY.md`), so measuring
 * `process.cwd()` made the METRIC values depend on the absolute path of the
 * checkout: inside an agent worktree (`<main>/.claude/worktrees/<name>`) the
 * longer path shifted char/token counts and false-failed the baseline gate,
 * training everyone to push with `--no-verify`.
 *
 * `resolveBenchRoot()` derives the root from this script's own location
 * (`import.meta.url`, never cwd) and, when that root is a linked git worktree
 * (`.git` is a `gitdir:` pointer file instead of a directory), normalizes it
 * to the main checkout's root so the measured path — and therefore every
 * METRIC — is byte-identical in worktrees and in the main repo.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveBenchRoot(): string {
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
	return resolveWorktreeMainRoot(repoRoot) ?? repoRoot;
}

/** If `root` is a linked git worktree, return the main checkout root. */
function resolveWorktreeMainRoot(root: string): string | undefined {
	try {
		const gitPath = join(root, ".git");
		if (!existsSync(gitPath) || !statSync(gitPath).isFile()) return undefined;
		const match = readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+)$/m);
		if (!match) return undefined;
		// A linked worktree's gitdir points at `<main>/.git/worktrees/<name>`.
		const gitDir = resolve(root, match[1].trim());
		const worktreesDir = dirname(gitDir);
		if (basename(worktreesDir) !== "worktrees") return undefined;
		const dotGit = dirname(worktreesDir);
		if (basename(dotGit) !== ".git") return undefined;
		const mainRoot = dirname(dotGit);
		return existsSync(join(mainRoot, "package.json")) ? mainRoot : undefined;
	} catch {
		return undefined;
	}
}
