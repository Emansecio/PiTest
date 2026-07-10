import { afterEach, describe, expect, it } from "vitest";
import { effectiveFindDefaultLimit, FIND_DEFAULT_LIMIT_CEILING } from "../src/core/tools/find.ts";
import { getOccupancyScale, refreshOccupancyTruncationCaps } from "../src/core/tools/truncate.ts";

afterEach(() => {
	refreshOccupancyTruncationCaps(null);
});

describe("effectiveFindDefaultLimit", () => {
	it("returns the ceiling at low occupancy", () => {
		refreshOccupancyTruncationCaps({ percent: 40 });
		expect(effectiveFindDefaultLimit()).toBe(FIND_DEFAULT_LIMIT_CEILING);
		expect(FIND_DEFAULT_LIMIT_CEILING).toBe(500);
	});

	it("scales down at high occupancy with a 100-result floor", () => {
		refreshOccupancyTruncationCaps({ percent: 90 });
		const expected = Math.max(100, Math.round(FIND_DEFAULT_LIMIT_CEILING * getOccupancyScale()));
		expect(effectiveFindDefaultLimit()).toBe(expected);
		expect(expected).toBe(125);
		refreshOccupancyTruncationCaps({ percent: 99 });
		expect(effectiveFindDefaultLimit()).toBe(125);
	});

	it("does not scale an explicit model limit", async () => {
		refreshOccupancyTruncationCaps({ percent: 90 });
		const { createFindToolDefinition } = await import("../src/core/tools/find.ts");
		const def = createFindToolDefinition("/proj", {
			operations: {
				exists: () => true,
				glob: (_pattern, _cwd, options) => Array.from({ length: options.limit }, (_, i) => `f${i}.ts`),
			},
		});
		const ctx = {} as Parameters<typeof def.execute>[4];
		const res = (await def.execute("t", { pattern: "*", limit: 500 }, undefined, undefined, ctx)) as {
			details?: { resultLimitReached?: number };
		};
		expect(res.details?.resultLimitReached).toBe(500);
	});
});
