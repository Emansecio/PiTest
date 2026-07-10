import { visibleWidth } from "@pit/tui";
import { describe, expect, it } from "vitest";
import {
	type SystemMessageKind,
	systemMessageLabel,
} from "../src/modes/interactive/components/system-message-glyphs.js";

const EXPECTED: Record<SystemMessageKind, string> = {
	compaction: "⟳ compaction",
	branch: "⑂ branch",
	skill: "◆ skill",
	done: "✓ done",
	overthink: "◈ overthink",
	ttsr: "◈ ttsr",
	steer: "▸ steer",
	queued: "◷ queued",
};

describe("systemMessageLabel", () => {
	it("returns the expected glyph + word for every kind", () => {
		for (const [kind, expected] of Object.entries(EXPECTED) as [SystemMessageKind, string][]) {
			expect(systemMessageLabel(kind)).toBe(expected);
		}
	});

	it("prefixes each label with a width-1 glyph", () => {
		const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
		for (const kind of Object.keys(EXPECTED) as SystemMessageKind[]) {
			const label = systemMessageLabel(kind);
			const first = [...segmenter.segment(label)][0]?.segment;
			expect(first).toBeDefined();
			expect(visibleWidth(first!)).toBe(1);
		}
	});
});
