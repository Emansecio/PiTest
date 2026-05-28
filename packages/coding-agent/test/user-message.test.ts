import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

// Gutter character used by the unified MessageShell. Kept in sync with the
// `SHELL_GUTTER_CHAR` constant — duplicating the literal here keeps the test
// independent of the shell module surface.
const GUTTER_CHAR = "│";

describe("UserMessageComponent", () => {
	test("renders the message text on a gutter-prefixed line", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		// Layout after Leva 2 migration:
		//   line 0 → shell leading blank (with OSC 133;A marker prepended)
		//   line 1 → "│ hello"           (gutter + content)
		// The closing OSC 133;B + 133;C markers ride the LAST rendered line.
		expect(lines.length).toBeGreaterThanOrEqual(2);
		const contentLine = lines.find((line) => stripAnsi(line).includes("hello"));
		expect(contentLine).toBeDefined();
		expect(stripAnsi(contentLine ?? "")).toContain(`${GUTTER_CHAR} hello`);
	});

	test("wraps output with OSC 133 zone markers for terminal integration", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		// `;A` (zone start) lives on the first rendered line — terminals scan
		// sequentially, position within the line is irrelevant. With the
		// shell's leading blank, the first line is the empty spacer.
		expect(lines[0]).toContain(OSC133_ZONE_START);

		// `;B` + `;C` (zone end + command final) ride the last rendered line.
		const last = lines[lines.length - 1];
		expect(last).toContain(OSC133_ZONE_END);
		expect(last).toContain(OSC133_ZONE_FINAL);
	});

	test("renders empty input as no output at all (shell collapses)", () => {
		initTheme("dark");

		const component = new UserMessageComponent("");
		const lines = component.render(20);

		// Empty markdown produces no child lines → MessageShell returns [].
		// No OSC markers either; an empty zone is meaningless to terminals.
		expect(lines).toEqual([]);
	});
});
