import type { AssistantMessage } from "@pit/ai";
import { beforeAll, describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

beforeAll(() => initTheme("dark"));

function textMsg(text: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as unknown as AssistantMessage;
}

// Long single-paragraph prose (~269 cols, no hard breaks) so a full-width render
// fills a wide terminal and a capped render must wrap well below it.
const LONG = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");

// Widest line of real content (ANSI stripped, trailing pad removed). ASCII-only
// text ⇒ visible width == string length.
function maxContentWidth(lines: string[]): number {
	return Math.max(0, ...lines.map((l) => stripAnsi(l).trimEnd().length));
}

function proseComponent(readingColumns?: number): AssistantMessageComponent {
	const c =
		readingColumns === undefined
			? new AssistantMessageComponent(undefined, false, undefined, undefined, undefined, false)
			: new AssistantMessageComponent(undefined, false, undefined, undefined, undefined, false, readingColumns);
	c.updateContent(textMsg(LONG));
	return c;
}

describe("assistant prose width", () => {
	// The default used to cap prose at 88 cols; like Claude Code it should now use
	// the whole terminal so wide windows aren't half-empty.
	it("uses the full terminal width by default (no fixed reading-column cap)", () => {
		expect(maxContentWidth(proseComponent().render(200))).toBeGreaterThan(88);
	});

	it("treats readingColumns=0 as full width (cap disabled)", () => {
		expect(maxContentWidth(proseComponent(0).render(200))).toBeGreaterThan(88);
	});

	it("still caps prose when a positive reading column is opted in", () => {
		expect(maxContentWidth(proseComponent(80).render(200))).toBeLessThanOrEqual(80);
	});

	// Responsiveness: the same instance must reflow to whatever width it is given
	// instead of freezing at a fixed cap above 88 (the old "not responsive" feel).
	it("reflows prose to the terminal width on resize", () => {
		const c = proseComponent();
		const wide = maxContentWidth(c.render(200));
		const narrow = maxContentWidth(c.render(120));
		expect(wide).toBeGreaterThan(narrow);
		expect(narrow).toBeGreaterThan(100); // a 120-col terminal exceeds the old 88 cap
	});
});
