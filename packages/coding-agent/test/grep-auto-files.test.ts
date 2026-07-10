/**
 * Grep auto-switch: when outputMode is omitted and matches exceed the threshold,
 * return files_with_matches (+ notice) instead of full content lines.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";

const ctx = {} as Parameters<ReturnType<typeof createGrepToolDefinition>["execute"]>[4];
const TOKEN = "AutoSwitchUniqueTokenXYZ";

let root: string;

beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), "grep-auto-"));
	// 30 files × 1 match each → above GREP_AUTO_FILES_THRESHOLD (25).
	for (let i = 0; i < 30; i++) {
		writeFileSync(path.join(root, `f${i}.ts`), `const x = "${TOKEN}";\n`);
	}
});

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

async function run(args: {
	pattern: string;
	literal?: boolean;
	outputMode?: "content" | "files_with_matches" | "count";
}): Promise<string> {
	const def = createGrepToolDefinition(root, { engine: "rg" });
	const res = (await def.execute("t", args, undefined, undefined, ctx)) as {
		content: Array<{ type: string; text?: string }>;
	};
	return res.content[0]?.text ?? "";
}

describe("grep auto-switch to files_with_matches", () => {
	it("auto-switches when outputMode is omitted and matches exceed threshold", async () => {
		const out = await run({ pattern: TOKEN, literal: true });
		expect(out).toContain("Auto-switched to files_with_matches");
		expect(out).toMatch(/f\d+\.ts/);
		// Content mode would include "const x =" lines; locate mode is paths only.
		expect(out).not.toMatch(/const x =/);
	});

	it("keeps content lines when outputMode is explicitly content", async () => {
		const out = await run({ pattern: TOKEN, literal: true, outputMode: "content" });
		expect(out).not.toContain("Auto-switched");
		expect(out).toMatch(/const x =/);
	});

	it("respects PIT_NO_GREP_AUTO_FILES opt-out", async () => {
		const prev = process.env.PIT_NO_GREP_AUTO_FILES;
		process.env.PIT_NO_GREP_AUTO_FILES = "1";
		try {
			const out = await run({ pattern: TOKEN, literal: true });
			expect(out).not.toContain("Auto-switched");
			expect(out).toMatch(/const x =/);
		} finally {
			if (prev === undefined) delete process.env.PIT_NO_GREP_AUTO_FILES;
			else process.env.PIT_NO_GREP_AUTO_FILES = prev;
		}
	});
});
