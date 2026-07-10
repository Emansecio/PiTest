/**
 * D13: Tier-4 recovery hints for `lsp` and `ast_edit`.
 *
 * Each assertion drives a real error string those tools emit through the default
 * registry and checks the matching hint fires. Also asserts rules stay quiet on
 * unrelated errors and do not duplicate symbol's inline "Did you mean" recovery.
 */

import { describe, expect, it } from "vitest";
import { createDefaultToolErrorHintRegistry } from "../src/core/tool-error-hint-rules.ts";
import { AST_GREP_INSTALL_HINT } from "../src/core/tools/ast-grep-shared.ts";

const reg = createDefaultToolErrorHintRegistry();
type Call = Parameters<typeof reg.apply>[0];
type Result = Parameters<typeof reg.apply>[1];

const call = (name: string, args: Record<string, unknown>): Call => ({
	type: "toolCall",
	id: "d13",
	name,
	arguments: args,
});
const errResult = (text: string): Result => ({ content: [{ type: "text", text }], details: undefined }) as Result;

const hintsFor = (name: string, args: Record<string, unknown>, text: string): string =>
	createDefaultToolErrorHintRegistry()
		.apply(call(name, args), errResult(text))
		.hints.map((h) => h.hint)
		.join("\n");

describe("D13: lsp recovery hints", () => {
	it("no server mapped → check lsp config or fall back", () => {
		const hints = hintsFor("lsp", { action: "hover", file: "foo.xyz" }, "No language server found for this action");
		expect(/lsp\.json/i.test(hints)).toBe(true);
		expect(/symbol/i.test(hints)).toBe(true);
	});

	it("spawn ENOENT (wrapped) → install server binary", () => {
		const hints = hintsFor(
			"lsp",
			{ action: "hover", file: "src/app.ts", line: 1, symbol: "foo" },
			"LSP error on typescript: spawn typescript-language-server ENOENT",
		);
		expect(/language server binary failed/i.test(hints)).toBe(true);
		expect(/PATH/i.test(hints)).toBe(true);
	});

	it("file not found → find by basename", () => {
		const hints = hintsFor(
			"lsp",
			{ action: "hover", file: "src/missing.ts", line: 1, symbol: "foo" },
			"LSP error on typescript: File not found: src/missing.ts",
		);
		expect(/file not found/i.test(hints)).toBe(true);
		expect(hints).toContain('find({pattern:"**/missing.ts"}');
	});

	it("does NOT fire on symbol inline recovery (nearby line hint already in error)", () => {
		const err = 'LSP error on typescript: Symbol "foo" not found on line 5; found on line 12 — pass line=12';
		const hints = hintsFor("lsp", { action: "hover", file: "src/app.ts", line: 5, symbol: "foo" }, err);
		expect(hints).toBe("");
	});

	it("does NOT fire on a successful-shaped diagnostics result", () => {
		const hints = hintsFor("lsp", { action: "diagnostics", file: "src/app.ts" }, "No diagnostics found");
		expect(hints).toBe("");
	});
});

describe("D13: ast_edit recovery hints", () => {
	it("missing ast-grep CLI → install or use edit/grep", () => {
		const hints = hintsFor(
			"ast_edit",
			{ pattern: "console.log($X)", rewrite: "logger.debug($X)" },
			AST_GREP_INSTALL_HINT,
		);
		expect(/not on PATH/i.test(hints)).toBe(true);
		expect(/edit/i.test(hints)).toBe(true);
	});

	it("pattern parse error → valid code snippet, not regex", () => {
		const err =
			"Error: Cannot parse query as a valid pattern.\nHelp: The pattern either fails to parse or contains error.";
		const hints = hintsFor("ast_edit", { pattern: "class $A", rewrite: "class $B", lang: "py" }, err);
		expect(/could not parse/i.test(hints)).toBe(true);
		expect(/\$META/i.test(hints)).toBe(true);
	});

	it("multiple AST nodes → pattern parse hint", () => {
		const err =
			"Error: Cannot parse query as a valid pattern.\n╰▻ Multiple AST nodes are detected. Please check the pattern source `foo() bar()`.";
		const hints = hintsFor("ast_edit", { pattern: "foo() bar()", rewrite: "x", lang: "ts" }, err);
		expect(/could not parse/i.test(hints)).toBe(true);
	});

	it("does NOT duplicate the install hint on a pattern-parse error path", () => {
		const err = AST_GREP_INSTALL_HINT;
		const hints = hintsFor("ast_edit", { pattern: "bad", rewrite: "x" }, err);
		expect(/could not parse/i.test(hints)).toBe(false);
	});

	it("does NOT fire on a plain no-match success", () => {
		const hints = hintsFor(
			"ast_edit",
			{ pattern: "neverMatches($X)", rewrite: "x", dry_run: true },
			"No matches found",
		);
		expect(hints).toBe("");
	});
});
