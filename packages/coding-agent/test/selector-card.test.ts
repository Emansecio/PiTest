import { Text } from "@pit/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { SelectorCard } from "../src/modes/interactive/components/selector-card.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => {
	initTheme("dark");
});

describe("SelectorCard", () => {
	it("renders rounded top and bottom borders", () => {
		const card = new SelectorCard();
		card.addChild(new Text("hello", 0, 0));

		const lines = card.render(40).map(stripAnsi);

		expect(lines[0]).toContain("╭");
		expect(lines[lines.length - 1]).toContain("╰");
	});
});
