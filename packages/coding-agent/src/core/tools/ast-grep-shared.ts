import { needsWindowsShell, which } from "../lsp/internal.ts";

export const AST_GREP_INSTALL_HINT =
	"ast-grep CLI not installed. Install: https://ast-grep.github.io/guide/quick-start.html";

/**
 * Missing/unspawnable binary must always surface as an error, never as a
 * quiet "0 matches" success. `ENOENT` (not on PATH) and the shell's own
 * "not found" phrasing (POSIX `command not found`, cmd.exe `not recognized`)
 * were already covered; `EINVAL` is the Windows-specific failure mode where
 * Node (>= 20.12) refuses to `spawn()`/`execFile()` a `.cmd`/`.bat` shim
 * directly with `shell:false` — exactly what an npm-installed `ast-grep`
 * resolves to on Windows. `resolveAstGrepSpawnStrategy` below routes those
 * shims through cmd.exe so EINVAL should no longer occur in practice; this
 * check remains as defense-in-depth for any binary path that bypasses it.
 */
export function isMissingBinaryError(err: NodeJS.ErrnoException | Error): boolean {
	const code = (err as NodeJS.ErrnoException).code;
	if (code === "ENOENT" || code === "EINVAL") return true;
	const message = (err.message || "").toLowerCase();
	return message.includes("command not found") || message.includes("not recognized") || message.includes("enoent");
}

// Glob patterns are forward-slash only. A Windows-style backslash glob
// (e.g. `src\**\*.ts`) is forwarded raw to ast-grep --globs, where "\" is a
// glob escape — so it silently matches nothing and reports zero results with
// no hint about the separator. Enrich the empty message so the model can
// self-correct, mirroring find.ts/grep.ts. The success path stays untouched.
// Shared by ast_grep and ast_edit so both zero-match paths give the same hint.
export function noMatchesMessage(globs: string[] | undefined): string {
	const offending = globs?.find((g) => g.includes("\\"));
	if (offending !== undefined) {
		return `No matches found. Glob patterns use forward slashes; try: ${offending.replace(/\\/g, "/")}`;
	}
	return "No matches found";
}

/**
 * Quote one command/arg token for a Windows `cmd.exe` shell spawn, hardened
 * for model-controlled input (ast-grep `pattern`/`rewrite`/`globs` are free
 * text from the model). Wraps the token in double quotes when it contains
 * whitespace, a quote, or any cmd.exe metacharacter (& | < > ^ ( ) % !) —
 * inside a double-quoted token cmd.exe treats those as literal data, which
 * neutralizes command injection. Embedded quotes are doubled. Mirrors
 * recipe.ts's `quoteRecipeShellArg` (kept local here rather than imported —
 * ast-grep's spawn strategy is independent of recipe's task-runner one).
 */
export function quoteAstGrepShellArg(value: string): string {
	if (value.length > 0 && !/[\s"&|<>^()%!]/.test(value)) return value;
	return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Decide how to spawn `binary` with `args`. On Windows a `.cmd`/`.bat` shim
 * (an npm-installed `ast-grep`/`sg`) cannot be spawned directly — Node >= 20.12
 * throws `EINVAL` for `shell:false` — so it must go through cmd.exe with every
 * token quoted by {@link quoteAstGrepShellArg}. Native executables (.exe/.com)
 * and all POSIX binaries spawn with `shell:false`, where the args array goes
 * straight to execvp with no shell re-interpretation (injection-safe).
 *
 * When the binary can't be resolved on Windows, fall back to the shell so a
 * shim `which` missed still runs; a truly missing binary then surfaces via
 * cmd.exe's own "not recognized" error, still caught by
 * {@link isMissingBinaryError}.
 */
export function resolveAstGrepSpawnStrategy(
	binary: string,
	args: string[],
): { command: string; args: string[]; useShell: boolean } {
	const resolved = which(binary);
	const useShell = process.platform === "win32" ? (resolved ? needsWindowsShell(resolved) : true) : false;
	const command = resolved ?? binary;
	if (useShell) {
		return { command: quoteAstGrepShellArg(command), args: args.map(quoteAstGrepShellArg), useShell };
	}
	return { command, args, useShell };
}

export function parseJsonStream<T extends object>(stdout: string): T[] {
	const out: T[] = [];
	const trimmed = stdout.trim();
	if (!trimmed) return out;
	if (trimmed.startsWith("[")) {
		try {
			const arr = JSON.parse(trimmed);
			if (Array.isArray(arr)) for (const m of arr) if (m && typeof m === "object") out.push(m as T);
		} catch {
			// fall through
		}
		if (out.length > 0) return out;
	}
	for (const line of trimmed.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const parsed = JSON.parse(t);
			if (parsed && typeof parsed === "object") out.push(parsed as T);
		} catch {
			// skip
		}
	}
	return out;
}
