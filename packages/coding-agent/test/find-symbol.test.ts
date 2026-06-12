import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFindSymbolTool } from "../src/core/tools/find-symbol.js";

const dir = mkdtempSync(join(tmpdir(), "pit-find-symbol-"));
mkdirSync(join(dir, "src"), { recursive: true });
writeFileSync(join(dir, "src", "a.ts"), "export function target() {}\n");
writeFileSync(join(dir, "src", "b.ts"), "const other = 1;\n");

describe("find_symbol", () => {
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("locates a declaration across files", async () => {
		const tool = createFindSymbolTool(dir);
		const res = await tool.execute("t", { name: "target" });
		const c = res.content[0];
		const text = c?.type === "text" ? c.text : "";
		expect(text).toContain("a.ts");
		expect(text).toContain("target");
	});

	it("suggests grep on zero matches instead of throwing", async () => {
		const tool = createFindSymbolTool(dir);
		const res = await tool.execute("t", { name: "doesNotExist" });
		const c = res.content[0];
		const text = c?.type === "text" ? c.text : "";
		expect(text.toLowerCase()).toContain("grep");
	});
});
