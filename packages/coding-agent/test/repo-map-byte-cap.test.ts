import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRepoMapTool } from "../src/core/tools/repo-map.js";

const MAX_BYTES = 50 * 1024;

// "\u4e2d" is a 3-byte UTF-8 char that is a single UTF-16 unit, so .length
// badly undercounts its real byte size.
const CJK = "\u4e2d".repeat(15);

const dir = mkdtempSync(join(tmpdir(), "pit-repo-map-bytes-"));
const cjkDir = join(dir, CJK);
mkdirSync(cjkDir, { recursive: true });
const FILE_COUNT = 900;
for (let i = 0; i < FILE_COUNT; i++) {
	writeFileSync(join(cjkDir, `${CJK}${i}.ts`), "export const x = 1;\n");
}

describe("repo_map byte budget honors UTF-8 bytes, not UTF-16 units (#20)", () => {
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("does not overshoot MAX_BYTES with multibyte paths", async () => {
		const tool = createRepoMapTool(dir);
		const res = await tool.execute("t", {});
		const c = res.content[0];
		const text = c?.type === "text" ? c.text : "";
		const realBytes = Buffer.byteLength(text, "utf8");
		// The full set would be well over MAX_BYTES in UTF-8; the cap must fire.
		expect(text).toContain("truncated: byte limit reached");
		// Allow a little slack for the final line that tripped the cap + marker.
		expect(realBytes).toBeLessThanOrEqual(MAX_BYTES + 1024);
	});
});
