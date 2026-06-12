import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRepoMapTool } from "../src/core/tools/repo-map.js";

const dir = mkdtempSync(join(tmpdir(), "pit-repo-map-"));
mkdirSync(join(dir, "src"), { recursive: true });
writeFileSync(join(dir, "src", "a.ts"), "export function alpha() {}\nexport const beta = 1;\n");

describe("repo_map", () => {
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("emits path: symbol list without bodies", async () => {
		const tool = createRepoMapTool(dir);
		const res = await tool.execute("t", {});
		const c = res.content[0];
		const text = c?.type === "text" ? c.text : "";
		expect(text).toContain("src");
		expect(text).toContain("a.ts");
		expect(text).toContain("alpha");
		expect(text).toContain("beta");
		expect(text).not.toContain("export function alpha() {}");
	});
});
