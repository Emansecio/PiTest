/**
 * C1: recovery-hint coverage for the tools that previously had ZERO rules —
 * `write`, `find`, `grep`, and `ls`. Each assertion drives a real error string
 * those tools emit (Node fs error messages, fd/rg stderr, and the tools' own
 * `Path not found:` / `Not a directory:` rejections) through the default
 * registry and checks the matching hint fires. The rules are conservative, so
 * we also assert they stay quiet on unrelated errors.
 */

import { describe, expect, it } from "vitest";
import { createDefaultToolErrorHintRegistry } from "../src/core/tool-error-hint-rules.ts";

const reg = createDefaultToolErrorHintRegistry();
type Call = Parameters<typeof reg.apply>[0];
type Result = Parameters<typeof reg.apply>[1];

const call = (name: string, args: Record<string, unknown>): Call => ({
	type: "toolCall",
	id: "c1",
	name,
	arguments: args,
});
const errResult = (text: string): Result => ({ content: [{ type: "text", text }], details: undefined }) as Result;

/** Convenience: fire the default registry and return the joined hint text. */
const hintsFor = (name: string, args: Record<string, unknown>, text: string): string =>
	createDefaultToolErrorHintRegistry()
		.apply(call(name, args), errResult(text))
		.hints.map((h) => h.hint)
		.join("\n");

describe("C1: write recovery hints", () => {
	it("ENOENT → nudges to check the path / parent", () => {
		const hints = hintsFor(
			"write",
			{ path: "Z:/nope/x.ts", content: "" },
			"ENOENT: no such file or directory, open 'Z:/nope/x.ts'",
		);
		expect(/ENOENT/i.test(hints)).toBe(true);
		expect(/ls\(/i.test(hints)).toBe(true);
	});

	it("EACCES / EPERM → surface to user, do not chmod", () => {
		const acces = hintsFor(
			"write",
			{ path: "/etc/hosts", content: "" },
			"EACCES: permission denied, open '/etc/hosts'",
		);
		expect(/permission denied/i.test(acces)).toBe(true);
		expect(/do not silently .*chmod/i.test(acces)).toBe(true);
		expect(acces).toContain("/etc/hosts");

		const eperm = hintsFor(
			"write",
			{ path: "/root/x", content: "" },
			"EPERM: operation not permitted, open '/root/x'",
		);
		expect(/EACCES\/EPERM/.test(eperm)).toBe(true);
	});

	it("EISDIR → target is a directory, point at a file inside", () => {
		const hints = hintsFor(
			"write",
			{ path: "src", content: "" },
			"EISDIR: illegal operation on a directory, open 'src'",
		);
		expect(/EISDIR/.test(hints)).toBe(true);
		expect(/directory .*not a file|not a file/i.test(hints)).toBe(true);
		expect(hints).toContain('ls({path:"src"})');
	});

	it("accepts the write-specific file_path alias when path is absent", () => {
		const hints = hintsFor(
			"write",
			{ file_path: "/etc/hosts", content: "" },
			"EACCES: permission denied, open '/etc/hosts'",
		);
		expect(hints).toContain("/etc/hosts");
	});

	it("does NOT fire on an unrelated write error", () => {
		const hints = hintsFor("write", { path: "x.ts", content: "" }, "Scheme 'foo' does not support write.");
		expect(hints).toBe("");
	});
});

describe("C1: find recovery hints", () => {
	it("Path not found (custom-ops) → search root missing", () => {
		const hints = hintsFor("find", { pattern: "**/*.ts", path: "/gone" }, "Path not found: /gone");
		expect(/search directory/i.test(hints)).toBe(true);
		expect(hints).toContain("/gone");
	});

	it("fd stderr 'does not exist' → search root missing", () => {
		const hints = hintsFor(
			"find",
			{ pattern: "*.ts", path: "/gone" },
			'[fd error]: The directory "/gone" does not exist.',
		);
		expect(/search directory/i.test(hints)).toBe(true);
	});

	it("invalid glob → escape glob chars, not regex", () => {
		const hints = hintsFor("find", { pattern: "[abc" }, "error parsing glob '[abc': unclosed character class");
		expect(/glob pattern/i.test(hints)).toBe(true);
		expect(/grep/i.test(hints)).toBe(true);
	});

	it("does NOT fire on a plain no-match result", () => {
		const hints = hintsFor("find", { pattern: "*.zzz" }, "No files found matching pattern");
		expect(hints).toBe("");
	});
});

describe("C1: grep recovery hints", () => {
	it("Path not found → search root missing", () => {
		const hints = hintsFor("grep", { pattern: "foo", path: "/gone" }, "Path not found: /gone");
		expect(/search directory/i.test(hints)).toBe(true);
		expect(hints).toContain("/gone");
	});

	it("raw regex parse error (unenriched) → escape or set literal:true", () => {
		const hints = hintsFor("grep", { pattern: "foo(" }, "regex parse error: unclosed group");
		expect(/regex parse error/i.test(hints)).toBe(true);
		expect(/literal: true/i.test(hints)).toBe(true);
	});

	it("does NOT duplicate the already-enriched 'set literal: true' guidance", () => {
		// grep.ts already appends the literal:true advice on the ripgrep path; the
		// hint must stay silent so the model does not read the same fix twice.
		const enriched =
			"Invalid regex pattern: regex parse error: unclosed group. If you meant to match this text literally " +
			"(it contains regex metacharacters like ( ) [ ] . * + ? | \\ ), set literal: true.";
		const hints = hintsFor("grep", { pattern: "foo(" }, enriched);
		expect(hints).toBe("");
	});

	it("does NOT fire on a plain no-match result", () => {
		const hints = hintsFor("grep", { pattern: "foo" }, "No matches found");
		expect(hints).toBe("");
	});
});

describe("C1: ls recovery hints", () => {
	it("Path not found → try parent or find", () => {
		const hints = hintsFor("ls", { path: "/a/b/gone" }, "Path not found: /a/b/gone");
		expect(/directory not found/i.test(hints)).toBe(true);
		expect(hints).toContain('find({pattern:"**/gone"}');
	});

	it("ENOENT from readdir → same directory-not-found hint", () => {
		const hints = hintsFor(
			"ls",
			{ path: "/a/b/gone" },
			"Cannot read directory: ENOENT: no such file or directory, scandir '/a/b/gone'",
		);
		expect(/directory not found/i.test(hints)).toBe(true);
	});

	it("Not a directory → it is a file, read it or ls the parent", () => {
		const hints = hintsFor("ls", { path: "/a/file.ts" }, "Not a directory: /a/file.ts");
		expect(/is a file, not a directory/i.test(hints)).toBe(true);
		expect(/read\(/i.test(hints)).toBe(true);
	});

	it("ENOTDIR → file-not-directory hint", () => {
		const hints = hintsFor(
			"ls",
			{ path: "/a/file.ts/x" },
			"Cannot read directory: ENOTDIR: not a directory, scandir '/a/file.ts/x'",
		);
		expect(/is a file, not a directory/i.test(hints)).toBe(true);
	});

	it("does NOT fire on an empty-directory success-shaped result", () => {
		const hints = hintsFor("ls", { path: "/a" }, "(empty directory)");
		expect(hints).toBe("");
	});
});
