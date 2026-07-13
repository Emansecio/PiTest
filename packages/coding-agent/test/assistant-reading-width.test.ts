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
	it("caps prose at the default reading width (120 cols)", () => {
		const width = maxContentWidth(proseComponent().render(200));
		expect(width).toBeGreaterThan(100);
		expect(width).toBeLessThanOrEqual(120);
	});

	it("treats readingColumns=0 as full width (cap disabled)", () => {
		expect(maxContentWidth(proseComponent(0).render(200))).toBeGreaterThan(100);
	});

	it("still caps prose when a positive reading column is opted in", () => {
		expect(maxContentWidth(proseComponent(80).render(200))).toBeLessThanOrEqual(80);
	});

	it("reflows prose when the terminal is narrower than the reading cap", () => {
		const c = proseComponent();
		const wide = maxContentWidth(c.render(200));
		const narrow = maxContentWidth(c.render(80));
		expect(wide).toBeLessThanOrEqual(120);
		expect(narrow).toBeLessThanOrEqual(80);
		expect(narrow).toBeLessThan(wide);
	});
});
