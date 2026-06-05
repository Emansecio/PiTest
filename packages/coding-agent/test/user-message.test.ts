import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const OSC133_PROMPT_START = "\x1b]133;A\x07"; // FTCS A: prompt start
const OSC133_PROMPT_END = "\x1b]133;B\x07"; // FTCS B: command entered
const OSC133_OUTPUT_START = "\x1b]133;C\x07"; // FTCS C: belongs to the assistant, not here

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
		// The closing OSC 133;B marker rides the LAST rendered line.
		expect(lines.length).toBeGreaterThanOrEqual(2);
		const contentLine = lines.find((line) => stripAnsi(line).includes("hello"));
		expect(contentLine).toBeDefined();
		expect(stripAnsi(contentLine ?? "")).toContain(`${GUTTER_CHAR} hello`);
	});

	test("wraps output with the OSC 133 prompt zone (A … B), not the output zone", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		// `;A` (prompt start) lives on the first rendered line — terminals scan
		// sequentially, position within the line is irrelevant. With the
		// shell's leading blank, the first line is the empty spacer.
		expect(lines[0]).toContain(OSC133_PROMPT_START);

		// `;B` (command entered / end of prompt) rides the last rendered line.
		const last = lines[lines.length - 1];
		expect(last).toContain(OSC133_PROMPT_END);

		// The output zone (`;C`) belongs to the assistant response, never the
		// user prompt — emitting it here is what broke FTCS navigation.
		const all = lines.join("\n");
		expect(all).not.toContain(OSC133_OUTPUT_START);
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
