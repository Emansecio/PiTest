/**
 * Every path that measures or slices text has to agree on how wide a tab is.
 *
 * `visibleWidth` expands tabs to spaces before measuring and `truncateToWidth`
 * handles them explicitly, but `sliceWithWidth` and `extractSegments` fed raw
 * text to the grapheme segmenter — where a tab matched the zero-width test
 * (`\p{Control}`) and measured 0. A tabbed line therefore measured narrower than
 * it drew, so `sliceByColumn(line, 0, N, strict)` could return something wider
 * than N and the overlay compositor's final width clamp — commented as the last
 * safeguard against the crash — passed a line that overflowed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractSegments, sliceByColumn, truncateToWidth, visibleWidth } from "../src/utils.js";

describe("tab width consistency", () => {
	it("measures a tab as three columns everywhere", () => {
		assert.equal(visibleWidth("\t"), 3);
		assert.equal(visibleWidth("ab\tcd"), 7);
		// The slice must not exceed what was asked for.
		assert.ok(visibleWidth(sliceByColumn("ab\tcd", 0, 5, true)) <= 5);
		assert.ok(visibleWidth(truncateToWidth("ab\tcd", 5, "")) <= 5);
	});

	it("keeps a strict slice inside its budget for tab-heavy lines", () => {
		const line = "\t".repeat(20);
		assert.equal(visibleWidth(line), 60);
		for (const budget of [1, 5, 10, 30, 59]) {
			const slice = sliceByColumn(line, 0, budget, true);
			assert.ok(visibleWidth(slice) <= budget, `slice of ${budget} columns measured ${visibleWidth(slice)}`);
		}
	});

	it("reports the same width from extractSegments as from visibleWidth", () => {
		const { before, beforeWidth, after, afterWidth } = extractSegments("ab\tcd", 2, 2, 3);
		assert.equal(beforeWidth, visibleWidth(before));
		assert.equal(afterWidth, visibleWidth(after));
	});
});
