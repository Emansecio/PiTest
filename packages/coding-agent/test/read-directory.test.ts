import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.js";

/**
 * Reading a directory must NOT crash with "EISDIR: illegal operation on a
 * directory, read". A directory passes access(R_OK) but every read syscall on
 * it throws EISDIR — the tool detects it (via stat) or recovers from the raw
 * EISDIR (ops without stat) and returns an actionable note pointing at `ls`.
 */

const dir = mkdtempSync(join(tmpdir(), "pit-read-dir-"));
mkdirSync(join(dir, "06-Exploits"));
writeFileSync(join(dir, "file.txt"), "hello\n", "utf-8");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function textOf(result: { content: unknown[] }): string {
	return (result.content[0] as { text?: string } | undefined)?.text ?? "";
}

describe("read on a directory", () => {
	it("default ops: returns an actionable note, not EISDIR", async () => {
		const tool = createReadTool(dir, { embedHashlineAnchors: false });
		const result = await tool.execute("t-dir", { path: join(dir, "06-Exploits") });
		const text = textOf(result);
		expect(text).toContain("is a directory");
		expect(text).toContain("ls");
		expect(text).not.toContain("EISDIR");
	});

	it("ops without stat: recovers from raw EISDIR via the catch path", async () => {
		// Remote-style ops omit stat, so the early directory check is skipped and
		// the read syscall itself throws EISDIR — which must be converted, not surfaced.
		const tool = createReadTool(dir, {
			embedHashlineAnchors: false,
			operations: {
				readFile: (p) => fsReadFile(p),
				access: (p) => fsAccess(p),
			},
		});
		const result = await tool.execute("t-dir-nostat", { path: join(dir, "06-Exploits") });
		expect(textOf(result)).toContain("is a directory");
	});

	it("still reads a real file normally", async () => {
		const tool = createReadTool(dir, { embedHashlineAnchors: false });
		const result = await tool.execute("t-file", { path: join(dir, "file.txt") });
		expect(textOf(result)).toContain("hello");
	});
});
