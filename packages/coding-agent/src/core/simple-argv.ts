/**
 * Shared shell-command tokenizer for the bash-related guards/rewrites.
 *
 * A deliberately CONSERVATIVE argv parser: it tokenizes a command respecting
 * single/double quotes and backslash escapes, but BAILS (returns undefined) the
 * moment a shell metacharacter that could change semantics appears (pipes,
 * redirects, `&&`, `;`, `$(...)`, backticks, subshells). Callers treat that
 * undefined as "too complex to reason about — pass through untouched", which is
 * what keeps both the Tier-2 rewrite substitutions and the bash-grounding guard
 * fail-open on compound commands.
 *
 * Single source of truth: imported by `tool-rewrite-rules.ts` (Tier-2 bash ->
 * dedicated-tool substitution) and `bash-grounding.ts` (npm/pnpm/yarn run <script>
 * grounding).
 */

/**
 * Parse a `bash` command into its leading argv tokens, respecting single and
 * double quotes. Returns undefined when the command contains shell metacharacters
 * that would change semantics (pipes, redirects, `&&`, `;`, `$(...)`, backticks,
 * subshells). A bare `*` is passed through as a literal argument, not rejected.
 */
export function parseSimpleArgv(command: string): string[] | undefined {
	if (!command.trim()) return undefined;
	// Reject any shell metacharacter that would change semantics under substitution.
	if (/[|;&`$()<>]/.test(command)) return undefined;
	const argv: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += command[i + 1];
			i++;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current.length > 0) {
				argv.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (quote) return undefined;
	if (current.length > 0) argv.push(current);
	return argv;
}
