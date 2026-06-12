import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.js";

const dir = mkdtempSync(join(tmpdir(), "pit-read-outline-"));
writeFileSync(join(dir, "f.ts"), "export function alpha() {}\nexport class Beta {}\n");

describe("read outline mode", () => {
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("returns symbol outline instead of full content", async () => {
		const tool = createReadTool(dir, { embedHashlineAnchors: false });
		const res = await tool.execute("t", { path: "f.ts", outline: true });
		const c = res.content[0];
		const text = c?.type === "text" ? c.text : "";
		expect(text).toContain("alpha");
		expect(text).toContain("Beta");
		expect(text).toContain("L1"); // line range present
		expect(text).not.toContain("export function alpha() {}"); // not the body
	});
});
