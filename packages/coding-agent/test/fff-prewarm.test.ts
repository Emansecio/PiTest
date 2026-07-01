import { describe, expect, it } from "vitest";
import { prewarmFffIndex } from "../src/core/tools/fff-search.ts";

describe("fff prewarm", () => {
	it("prewarmFffIndex does not throw when invoked", () => {
		expect(() => prewarmFffIndex(process.cwd())).not.toThrow();
	});
});
