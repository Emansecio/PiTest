import { existsSync } from "node:fs";
import { visibleWidth } from "@pit/tui";
import { describe, expect, it } from "vitest";
import type { AskOptionsRequest } from "../src/core/user-input-bus.js";
import { createAskPicker } from "../src/modes/interactive/components/ask-picker.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

// Guards against src↔dist drift: the pit binary loads workspace packages from
// their gitignored `dist`, not `src`. The src block always runs; the dist block
// fails loudly when dist is absent so a stale binary cannot ship silently.
const distComponentsUrl = new URL("../dist/modes/interactive/components/ask-picker.js", import.meta.url);
const distThemeUrl = new URL("../dist/modes/interactive/theme/theme.js", import.meta.url);
const distBuilt = existsSync(distComponentsUrl);

function adversarialReq(): AskOptionsRequest {
	return {
		requestId: "r",
		header: "h".repeat(200),
		question: `Como tratar o ${"fade-in ".repeat(40)}de blocos do P5 (o fade do gutter já está pronto)?`,
		options: [
			{
				label: "Sim, rebuild tui + coding-agent dist e rode o teste",
				description: "x".repeat(200),
				recommended: true,
			},
			{ label: "y".repeat(200), description: "z".repeat(200) },
		],
		source: {},
	};
}

function assertWidthBounded(render: (width: number) => string[]): void {
	for (const width of [40, 80, 120]) {
		for (const line of render(width)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	}
}

describe("ask-picker src width guard", () => {
	it("never renders a line wider than the terminal (src)", () => {
		initTheme(undefined, false);
		const { component } = createAskPicker(adversarialReq(), () => {});
		assertWidthBounded((width) => component.render(width));
	});
});

describe("ask-picker compiled dist (src↔dist drift guard)", () => {
	it("never renders a line wider than the terminal (dist)", async () => {
		if (!distBuilt) {
			throw new Error("coding-agent dist missing — run `npm run build` before this test");
		}
		const { initTheme } = await import(distThemeUrl.href);
		const { createAskPicker: createDistAskPicker } = await import(distComponentsUrl.href);
		initTheme(undefined, false);

		const { component } = createDistAskPicker(adversarialReq(), () => {});
		assertWidthBounded((width) => component.render(width));
	});
});
