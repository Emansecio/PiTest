import { visibleWidth } from "@pit/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { PendingUserMessageComponent } from "../src/modes/interactive/components/pending-user-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

beforeAll(() => {
	initTheme("dark");
});

describe("PendingUserMessageComponent", () => {
	it("renders steer and queued labels", () => {
		const steer = new PendingUserMessageComponent("steer", "fix the footer");
		const queued = new PendingUserMessageComponent("queued", "then run tests");
		expect(steer.render(80).map(stripAnsi).join("\n")).toContain("[steer]");
		expect(queued.render(80).map(stripAnsi).join("\n")).toContain("[queued]");
		expect(steer.render(80).map(stripAnsi).join("\n")).toContain("fix the footer");
		expect(queued.render(80).map(stripAnsi).join("\n")).toContain("then run tests");
	});

	it("keeps rendered lines within width", () => {
		for (const width of [30, 80]) {
			const component = new PendingUserMessageComponent("steer", "a".repeat(200));
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("truncates long text with an ellipsis", () => {
		const component = new PendingUserMessageComponent("queued", "word ".repeat(40));
		const plain = component.render(30).map(stripAnsi).join("\n");
		expect(plain).toContain("…");
	});

	it("collapses internal whitespace to a single line", () => {
		const component = new PendingUserMessageComponent("steer", "line one\nline two");
		const plain = component.render(80).map(stripAnsi).join("\n");
		expect(plain).toContain("line one line two");
		expect(plain).not.toContain("\nline two");
	});
});
