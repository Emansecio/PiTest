import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { access as fsAccess, readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.js";

/**
 * Reading a directory must NOT crash with "EISDIR: illegal operation on a
 * directory, read". A directory passes access(R_OK) but every read syscall on
 * it throws EISDIR — the tool detects it (via stat) or recovers from the raw
 * EISDIR (ops without stat) and returns a listing (like `ls`), falling back to
 * an actionable note when the ops can't list (remote without readdir).
 */

const dir = mkdtempSync(join(tmpdir(), "pit-read-dir-"));
mkdirSync(join(dir, "06-Exploits"));
mkdirSync(join(dir, "06-Exploits", "sub"));
writeFileSync(join(dir, "06-Exploits", "payload.txt"), "x\n", "utf-8");
mkdirSync(join(dir, "empty-dir"));
writeFileSync(join(dir, "file.txt"), "hello\n", "utf-8");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function textOf(result: { content: unknown[] }): string {
	return (result.content[0] as { text?: string } | undefined)?.text ?? "";
}

describe("read on a directory", () => {
	it("default ops: returns a directory listing, not EISDIR", async () => {
		const tool = createReadTool(dir, { embedHashlineAnchors: false });
		const result = await tool.execute("t-dir", { path: join(dir, "06-Exploits") });
		const text = textOf(result);
		expect(text).toContain("Directory");
		expect(text).toContain("payload.txt");
		expect(text).toContain("sub/"); // directories are suffixed with "/"
		expect(text).not.toContain("EISDIR");
	});

	it("empty directory: reports it as empty", async () => {
		const tool = createReadTool(dir, { embedHashlineAnchors: false });
		const result = await tool.execute("t-empty", { path: join(dir, "empty-dir") });
		expect(textOf(result)).toContain("empty");
	});

	it("ops with readdir but no stat: lists via the EISDIR catch path", async () => {
		// Remote-style ops omit stat, so the early directory check is skipped and
		// the read syscall throws EISDIR — recovered into a listing, not surfaced.
		const tool = createReadTool(dir, {
			embedHashlineAnchors: false,
			operations: {
				readFile: (p) => fsReadFile(p),
				access: (p) => fsAccess(p),
				readdir: async (p) =>
					(await fsReaddir(p, { withFileTypes: true })).map((e) => ({
						name: e.name,
						isDirectory: e.isDirectory(),
					})),
			},
		});
		const result = await tool.execute("t-dir-nostat", { path: join(dir, "06-Exploits") });
		const text = textOf(result);
		expect(text).toContain("payload.txt");
		expect(text).not.toContain("EISDIR");
	});

	it("ops without stat or readdir: falls back to the 'use ls' note", async () => {
		const tool = createReadTool(dir, {
			embedHashlineAnchors: false,
			operations: {
				readFile: (p) => fsReadFile(p),
				access: (p) => fsAccess(p),
			},
		});
		const result = await tool.execute("t-dir-minimal", { path: join(dir, "06-Exploits") });
		const text = textOf(result);
		expect(text).toContain("is a directory");
		expect(text).toContain("ls");
	});

	it("still reads a real file normally", async () => {
		const tool = createReadTool(dir, { embedHashlineAnchors: false });
		const result = await tool.execute("t-file", { path: join(dir, "file.txt") });
		expect(textOf(result)).toContain("hello");
	});
});
