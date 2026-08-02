import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearEditorConfigCache,
	detectIndentFromContent,
	resolveFormatOptions,
} from "../../src/core/lsp/format-options.ts";

describe("format options — content sniffing", () => {
	it("says nothing about a file with no indentation to go on", () => {
		expect(detectIndentFromContent("")).toBeUndefined();
		expect(detectIndentFromContent("a\nb\nc\n")).toBeUndefined();
	});

	it("reads plain 2- and 4-space files", () => {
		expect(detectIndentFromContent("a\n  b\n")).toEqual({ insertSpaces: true, tabSize: 2 });
		expect(detectIndentFromContent("a\n    b\n")).toEqual({ insertSpaces: true, tabSize: 4 });
	});

	it("takes the GCD across nesting depths rather than the first or deepest", () => {
		expect(detectIndentFromContent("a\n  b\n    c\n      d\n")).toEqual({ insertSpaces: true, tabSize: 2 });
		expect(detectIndentFromContent("a\n    b\n        c\n")).toEqual({ insertSpaces: true, tabSize: 4 });
	});

	it("detects tabs from a single tab-indented line", () => {
		expect(detectIndentFromContent("a\n\tb\n")?.insertSpaces).toBe(false);
	});

	it("ignores blank lines and continuation-width alignment", () => {
		expect(detectIndentFromContent("a\n\n   \n  b\n")).toEqual({ insertSpaces: true, tabSize: 2 });
		// A 40-space run is alignment under an open paren, not an indent level; if it
		// counted, the GCD would collapse to 2 against a genuinely 4-space file.
		expect(detectIndentFromContent(`a\n    b\n${" ".repeat(40)}c\n        d\n`)).toEqual({
			insertSpaces: true,
			tabSize: 4,
		});
	});
});

describe("format options — resolution", () => {
	let root: string;

	/** Project whose top-level `.editorconfig` cuts the walk, keeping tests hermetic. */
	function project(editorconfig: string): string {
		const dir = mkdtempSync(join(tmpdir(), "pit-fmt-"));
		writeFileSync(join(dir, ".editorconfig"), editorconfig);
		return dir;
	}

	beforeEach(() => {
		clearEditorConfigCache();
		root = "";
	});

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		clearEditorConfigCache();
	});

	it("does not reindent a tab file — the bug this replaced", () => {
		root = project("root = true\n");
		// No section matches, so content decides: tabs stay tabs. The old hardcoded
		// { tabSize: 4, insertSpaces: true } converted this file on every write.
		const options = resolveFormatOptions(join(root, "a.ts"), "class A {\n\tx = 1;\n}\n");
		expect(options.insertSpaces).toBe(false);
	});

	it("honours indent_style/indent_size from .editorconfig", () => {
		root = project("root = true\n\n[*]\nindent_style = space\nindent_size = 2\n");
		expect(resolveFormatOptions(join(root, "a.ts"), "a\n")).toMatchObject({ insertSpaces: true, tabSize: 2 });
	});

	it("honours indent_style = tab", () => {
		root = project("root = true\n\n[*]\nindent_style = tab\ntab_width = 4\n");
		expect(resolveFormatOptions(join(root, "a.ts"), "a\n  b\n")).toMatchObject({ insertSpaces: false, tabSize: 4 });
	});

	it("lets .editorconfig override what the content shows", () => {
		root = project("root = true\n\n[*]\nindent_style = space\nindent_size = 2\n");
		// Content is 4-space; the declared intent (2) wins.
		expect(resolveFormatOptions(join(root, "a.ts"), "a\n    b\n")).toMatchObject({ insertSpaces: true, tabSize: 2 });
	});

	it("resolves indent_size = tab through tab_width", () => {
		root = project("root = true\n\n[*]\nindent_style = tab\nindent_size = tab\ntab_width = 8\n");
		expect(resolveFormatOptions(join(root, "a.ts"), "a\n")).toMatchObject({ insertSpaces: false, tabSize: 8 });
	});

	it("applies a section only to the files it matches", () => {
		root = project("root = true\n\n[*.md]\nindent_style = space\nindent_size = 3\n");
		expect(resolveFormatOptions(join(root, "a.md"), "a\n")).toMatchObject({ tabSize: 3 });
		// .ts matches no section → content decides → tabs.
		expect(resolveFormatOptions(join(root, "a.ts"), "a\n\tb\n").insertSpaces).toBe(false);
	});

	it("lets the nearer .editorconfig win over the farther one", () => {
		root = project("root = true\n\n[*]\nindent_style = space\nindent_size = 8\n");
		const nested = join(root, "sub");
		mkdirSync(nested);
		writeFileSync(join(nested, ".editorconfig"), "[*]\nindent_style = space\nindent_size = 2\n");
		expect(resolveFormatOptions(join(nested, "a.ts"), "a\n")).toMatchObject({ tabSize: 2 });
		// The outer one still governs files beside it.
		expect(resolveFormatOptions(join(root, "a.ts"), "a\n")).toMatchObject({ tabSize: 8 });
	});

	it("stops the walk at root = true", () => {
		root = project("root = true\n\n[*]\nindent_style = space\nindent_size = 8\n");
		const nested = join(root, "sub");
		mkdirSync(nested);
		writeFileSync(join(nested, ".editorconfig"), "root = true\n");
		// The outer indent_size = 8 is above a root marker → must not apply.
		expect(resolveFormatOptions(join(nested, "a.ts"), "a\n")).toMatchObject({ tabSize: 2, insertSpaces: true });
	});

	it("falls back to 2 spaces when nothing declares or shows an indent", () => {
		root = project("root = true\n");
		expect(resolveFormatOptions(join(root, "a.ts"), "a\nb\n")).toMatchObject({ insertSpaces: true, tabSize: 2 });
	});

	it("survives a malformed .editorconfig instead of failing the write", () => {
		root = project("root = true\n[unclosed\n= = =\nindent_style\n\n[*]\nindent_size = notanumber\n");
		const options = resolveFormatOptions(join(root, "a.ts"), "a\n  b\n");
		expect(options).toMatchObject({ insertSpaces: true, tabSize: 2 });
	});

	it("always asks for trailing-whitespace and final-newline normalisation", () => {
		root = project("root = true\n");
		expect(resolveFormatOptions(join(root, "a.ts"), "a\n")).toMatchObject({
			trimTrailingWhitespace: true,
			insertFinalNewline: true,
			trimFinalNewlines: true,
		});
	});
});
