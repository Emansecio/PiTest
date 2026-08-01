import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const OSC133_PROMPT_START = "\x1b]133;A\x07"; // FTCS A: prompt start
const OSC133_PROMPT_END = "\x1b]133;B\x07"; // FTCS B: command entered
const OSC133_OUTPUT_START = "\x1b]133;C\x07"; // FTCS C: belongs to the assistant, not here

// Gutter character used by the user role: the delicate `❯` prompt tick (vs the
// shell's default `│`) — a minimal 1-column green marker echoing the editor's
// own prompt glyph, replacing the old heavy `▌` block. Duplicating the literal
// here keeps the test independent of the shell module surface.
const GUTTER_CHAR = "❯";

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

	test("repeated renders do not accumulate the OSC markers and keep a stable array identity", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const first = component.render(20);
		const firstBytes = first.slice();

		const second = component.render(20);
		const third = component.render(20);

		// Byte-identical across frames; decorating the shell's memoized array in
		// place would re-prefix A / re-suffix B every render.
		expect(second).toEqual(firstBytes);
		expect(third).toEqual(firstBytes);
		expect(third[0].split(OSC133_PROMPT_START).length - 1).toBe(1);
		expect(third[third.length - 1].split(OSC133_PROMPT_END).length - 1).toBe(1);
		// Unchanged content → same instance, so parent flatten caches stay warm.
		expect(second).toBe(first);
		// And the previously returned array was never mutated.
		expect(first).toEqual(firstBytes);
	});

	test("renders empty input as no output at all (shell collapses)", () => {
		initTheme("dark");

		const component = new UserMessageComponent("");
		const lines = component.render(20);

		// Empty markdown produces no child lines → MessageShell returns [].
		// No OSC markers either; an empty zone is meaningless to terminals.
		expect(lines).toEqual([]);
	});

	describe("near-literal rendering (paste accidents)", () => {
		test("pasted C code does not become a heading", () => {
			initTheme("dark");

			const component = new UserMessageComponent("# include <stdio.h>\nint main(void) { return 0; }");
			const plain = component.render(80).map((line) => stripAnsi(line));

			// The `#` line survives verbatim — not promoted to an H1 (which would
			// strip the marker and restyle the text).
			expect(plain.some((line) => line.includes("# include <stdio.h>"))).toBe(true);
			expect(plain.some((line) => line.includes("int main(void) { return 0; }"))).toBe(true);
		});

		test("a > line stays literal text, not a blockquote", () => {
			initTheme("dark");

			const component = new UserMessageComponent("> some quoted-looking paste");
			const plain = component.render(80).map((line) => stripAnsi(line));

			expect(plain.some((line) => line.includes("> some quoted-looking paste"))).toBe(true);
			expect(plain.some((line) => line.includes("│"))).toBe(false);
		});

		test("4-space indentation stays literal, not an indented code block", () => {
			initTheme("dark");

			const component = new UserMessageComponent("some text\n\n    indented paste line");
			const plain = component.render(80).map((line) => stripAnsi(line));

			expect(plain.some((line) => line.includes("    indented paste line"))).toBe(true);
			// No code-block frame corner.
			expect(plain.some((line) => line.includes("╭"))).toBe(false);
		});

		test("--- stays literal, not a rule that fakes a turn boundary", () => {
			initTheme("dark");

			const component = new UserMessageComponent("above\n\n---\n\nbelow");
			const plain = component.render(80).map((line) => stripAnsi(line));

			expect(plain.some((line) => line.includes("---"))).toBe(true);
			expect(plain.some((line) => line.includes("╌") || line.includes("─"))).toBe(false);
		});

		test("deliberate inline markdown still works: codespans and fences", () => {
			initTheme("dark");

			const component = new UserMessageComponent("run `npm test` first\n\n```c\nint x;\n```");
			const plain = component.render(80).map((line) => stripAnsi(line));

			// Codespan parsed (backticks consumed, content kept).
			expect(plain.some((line) => line.includes("run npm test first"))).toBe(true);
			// Explicit fence keeps its frame + body.
			expect(plain.some((line) => line.includes("╭"))).toBe(true);
			expect(plain.some((line) => line.includes("int x;"))).toBe(true);
		});
	});
});
