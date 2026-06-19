import { describe, expect, it } from "vitest";
import { createFindToolDefinition } from "../src/core/tools/find.ts";

/**
 * Regression for #19: a custom glob() backend that returns the search root
 * itself relativizes to "" and must not emit a blank line (nor count toward
 * the result limit).
 */
describe("find: custom glob returning the search root", () => {
	it("does not emit a blank line for the root directory", async () => {
		const root = "/proj/src";
		const def = createFindToolDefinition("/proj", {
			operations: {
				exists: () => true,
				// Return the root itself plus one real file.
				glob: () => [`${root}`, `${root}/a.ts`],
			},
		});
		const ctx = {} as Parameters<typeof def.execute>[4];
		const res = (await def.execute("t", { pattern: "*", path: "src" }, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
		};
		const text = res.content[0]?.text ?? "";
		const lines = text.split("\n");
		expect(lines).toContain("a.ts");
		// No blank line from the root directory.
		expect(lines).not.toContain("");
	});
});
