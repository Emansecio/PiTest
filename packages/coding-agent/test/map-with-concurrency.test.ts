import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/utils/map-with-concurrency.ts";

describe("mapWithConcurrency", () => {
	it("preserves order and caps in-flight work", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const items = Array.from({ length: 20 }, (_, i) => i);

		const results = await mapWithConcurrency(items, 4, async (item) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return item * 2;
		});

		expect(results).toEqual(items.map((i) => i * 2));
		expect(maxInFlight).toBeLessThanOrEqual(4);
		expect(maxInFlight).toBeGreaterThan(1);
	});

	it("returns empty array for empty input", async () => {
		expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
	});
});
