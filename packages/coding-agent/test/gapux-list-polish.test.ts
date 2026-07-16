import { describe, expect, it } from "vitest";
import { scrollPositionHint } from "../src/modes/interactive/components/keybinding-hints.ts";
import { paintSelectedRow, SelectableRow } from "../src/modes/interactive/components/selectable-row.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("scrollPositionHint", () => {
	it("returns empty when the full list fits", () => {
		expect(scrollPositionHint(0, 5, 0, 5)).toBe("");
	});

	it("shows ↓ when more items below", () => {
		expect(scrollPositionHint(0, 20, 0, 10)).toBe("   ↓ (1/20)");
	});

	it("shows ↑ when more items above", () => {
		expect(scrollPositionHint(15, 20, 10, 20)).toBe("  ↑  (16/20)");
	});

	it("shows ↑↓ when scrolled in the middle", () => {
		expect(scrollPositionHint(10, 30, 5, 15)).toBe("  ↑↓ (11/30)");
	});

	it("alwaysShow keeps a count line even when fully visible", () => {
		expect(scrollPositionHint(2, 5, 0, 5, { alwaysShow: true })).toBe("     (3/5)");
	});

	it("honors displayCurrent/displayTotal overrides", () => {
		expect(scrollPositionHint(4, 20, 0, 10, { displayCurrent: 2, displayTotal: 8 })).toBe("   ↓ (2/8)");
	});
});

describe("SkillInvocationMessageComponent", () => {
	it("renders MessageShell gutter + skill glyph label", () => {
		initTheme("dark");
		const comp = new SkillInvocationMessageComponent({
			name: "review",
			location: "/skills/review",
			content: "Do a careful review.",
			userMessage: undefined,
		});
		const plain = comp.render(80).map(stripAnsi).join("\n");
		expect(plain).toContain("◆ Skill");
		expect(plain).toContain("review");
		expect(plain).toContain("│");
		expect(plain).toMatch(/expand/i);
	});
});

describe("SelectableRow", () => {
	it("pads selected rows to width for selectedBg fill", () => {
		initTheme("dark");
		const row = new SelectableRow("→ item", true);
		const line = row.render(20)[0] ?? "";
		expect(stripAnsi(line).length).toBe(20);
		expect(line).toContain("\x1b[");
	});

	it("paintSelectedRow matches SelectableRow and leaves unselected flush", () => {
		initTheme("dark");
		const selected = paintSelectedRow("→ item", 20, true);
		expect(stripAnsi(selected).length).toBe(20);
		expect(selected).toContain("\x1b[");
		expect(selected).toBe(new SelectableRow("→ item", true).render(20)[0]);

		const unselected = paintSelectedRow("→ item", 20, false);
		expect(stripAnsi(unselected)).toBe("→ item");
		expect(unselected).toBe(new SelectableRow("→ item", false).render(20)[0]);
	});
});
