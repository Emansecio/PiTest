import assert from "node:assert";
import { describe, it } from "node:test";
import { Chalk } from "chalk";
import { TruncatedText } from "../src/components/truncated-text.js";
import { visibleWidth } from "../src/utils.js";

// Force full color in CI so ANSI assertions are deterministic
const chalk = new Chalk({ level: 3 });

// TruncatedText emits content as-is (truncated to fit) with NO pad-to-width:
// the renderer clears every line it rewrites and overlay compositing pads its
// own segments, so trailing spaces are dead bytes — and they overflow shells
// that prefix content (gutter + label). These tests assert lines never exceed
// the width and carry no trailing padding.

describe("TruncatedText component", () => {
	it("emits the content line without pad-to-width", () => {
		const text = new TruncatedText("Hello world", 1, 0);
		const lines = text.render(50);

		// Should have exactly one content line (no vertical padding)
		assert.strictEqual(lines.length, 1);

		// paddingX=1 margins survive; no fill to the full 50 columns.
		assert.strictEqual(lines[0], " Hello world ");
		assert.ok(visibleWidth(lines[0]) <= 50);
	});

	it("emits blank lines (not width-padded) for vertical padding", () => {
		const text = new TruncatedText("Hello", 0, 2);
		const lines = text.render(40);

		// Should have 2 padding lines + 1 content line + 2 padding lines = 5 total
		assert.strictEqual(lines.length, 5);

		// Vertical padding is blank, content is bare; nothing exceeds the width.
		assert.strictEqual(lines[0], "");
		assert.strictEqual(lines[1], "");
		assert.strictEqual(lines[2], "Hello");
		assert.strictEqual(lines[3], "");
		assert.strictEqual(lines[4], "");
	});

	it("truncates long text to the available width", () => {
		const longText = "This is a very long piece of text that will definitely exceed the available width";
		const text = new TruncatedText(longText, 1, 0);
		const lines = text.render(30);

		assert.strictEqual(lines.length, 1);

		// Truncated content + margins never exceed the viewport width.
		assert.strictEqual(visibleWidth(lines[0]), 30);

		// Should contain ellipsis
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(stripped.includes("…"));
	});

	it("preserves ANSI codes in output without padding", () => {
		const styledText = `${chalk.red("Hello")} ${chalk.blue("world")}`;
		const text = new TruncatedText(styledText, 1, 0);
		const lines = text.render(40);

		assert.strictEqual(lines.length, 1);

		// "Hello world" + 2 margin columns; ANSI codes don't count.
		assert.strictEqual(visibleWidth(lines[0]), 13);

		// Should preserve the color codes
		assert.ok(lines[0].includes("\x1b["));
	});

	it("truncates styled text and adds reset code before ellipsis", () => {
		const longStyledText = chalk.red("This is a very long red text that will be truncated");
		const text = new TruncatedText(longStyledText, 1, 0);
		const lines = text.render(20);

		assert.strictEqual(lines.length, 1);

		// Should be exactly 20 visible characters
		assert.strictEqual(visibleWidth(lines[0]), 20);

		// Should contain reset code before ellipsis
		assert.ok(lines[0].includes("\x1b[0m…"));
	});

	it("handles text that fits exactly", () => {
		// With paddingX=1, available width is 30-2=28
		// "Hello world" is 11 chars, fits comfortably
		const text = new TruncatedText("Hello world", 1, 0);
		const lines = text.render(30);

		assert.strictEqual(lines.length, 1);
		assert.strictEqual(lines[0], " Hello world ");

		// Should NOT contain ellipsis
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(!stripped.includes("…"));
	});

	it("handles empty text", () => {
		const text = new TruncatedText("", 1, 0);
		const lines = text.render(30);

		assert.strictEqual(lines.length, 1);
		// Just the two margin columns — no fill.
		assert.strictEqual(lines[0], "  ");
	});

	it("stops at newline and only shows first line", () => {
		const multilineText = "First line\nSecond line\nThird line";
		const text = new TruncatedText(multilineText, 1, 0);
		const lines = text.render(40);

		assert.strictEqual(lines.length, 1);
		assert.strictEqual(lines[0], " First line ");

		// Should only contain "First line"
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "").trim();
		assert.ok(stripped.includes("First line"));
		assert.ok(!stripped.includes("Second line"));
		assert.ok(!stripped.includes("Third line"));
	});

	it("truncates first line even with newlines in text", () => {
		const longMultilineText = "This is a very long first line that needs truncation\nSecond line";
		const text = new TruncatedText(longMultilineText, 1, 0);
		const lines = text.render(25);

		assert.strictEqual(lines.length, 1);
		assert.strictEqual(visibleWidth(lines[0]), 25);

		// Should contain ellipsis and not second line
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(stripped.includes("…"));
		assert.ok(!stripped.includes("Second line"));
	});

	// Memoization: TruncatedText re-renders every frame it's visible (per the
	// Component contract in tui.ts), so it must return the SAME array instance
	// when neither text nor width changed, and a NEW instance when either does
	// — a parent Container/Box relies on reference identity to skip re-flatten
	// work.
	describe("render memoization", () => {
		it("returns the same array reference across repeated renders with unchanged text/width", () => {
			const text = new TruncatedText("Hello world", 1, 0);
			const first = text.render(40);
			const second = text.render(40);
			assert.strictEqual(first, second);
		});

		it("returns a new array reference when width changes", () => {
			const text = new TruncatedText("Hello world", 1, 0);
			const first = text.render(40);
			const second = text.render(20);
			assert.notStrictEqual(first, second);
		});

		it("returns a new array reference after setText, and the same reference again once settled", () => {
			const text = new TruncatedText("Hello world", 1, 0);
			const first = text.render(40);
			text.setText("Goodbye world");
			const second = text.render(40);
			assert.notStrictEqual(first, second);
			assert.strictEqual(second[0], " Goodbye world ");

			const third = text.render(40);
			assert.strictEqual(second, third);
		});

		it("setText is a no-op (keeps the cache) when the text is unchanged", () => {
			const text = new TruncatedText("Hello world", 1, 0);
			const first = text.render(40);
			text.setText("Hello world");
			const second = text.render(40);
			assert.strictEqual(first, second);
		});

		it("returns a new array reference after invalidate()", () => {
			const text = new TruncatedText("Hello world", 1, 0);
			const first = text.render(40);
			text.invalidate();
			const second = text.render(40);
			assert.notStrictEqual(first, second);
			assert.deepStrictEqual(first, second);
		});
	});
});
