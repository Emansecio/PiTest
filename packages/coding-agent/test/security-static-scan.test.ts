import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanSecurityStatic } from "../src/core/security/static-scan.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pit-security-static-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("native ast-grep security rule packs", () => {
	it("emits structural matches only as candidate findings", async () => {
		writeFileSync(
			join(dir, "target.ts"),
			'export function run(userInput: string) { return eval(userInput); }\nexport const safe = JSON.parse("{}");\n',
		);
		const result = await scanSecurityStatic({ path: dir, language: "ts", pack: "javascript-core" });

		expect(result.engine).toBe("ast_grep");
		expect(result.findings).toEqual([
			expect.objectContaining({
				state: "candidate",
				ruleId: "js.dynamic-eval",
				file: expect.stringContaining("target.ts"),
			}),
		]);
		expect(result.findings.every((finding) => finding.state === "candidate")).toBe(true);
	});
});
