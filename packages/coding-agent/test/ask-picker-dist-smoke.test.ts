import { existsSync } from "node:fs";
import { visibleWidth } from "@pit/tui";
import { describe, expect, it } from "vitest";
import type { AskOptionsRequest } from "../src/core/user-input-bus.js";

// Guards against src↔dist drift: the pit binary (and vitest's own @pit/* deps)
// load workspace packages from their gitignored `dist`, not `src`. A fix landed
// in src but never rebuilt into dist ships a stale component — exactly the bug
// that crashed TUI.doRender from the `ask` overlay (long label + description
// overflowing the terminal width). This renders the *compiled* dist against the
// same adversarial input the src regression uses; if the dist is stale, it
// fails here instead of in the running binary. Skipped when dist is absent
// (fresh checkout that hasn't been built), so CI without a build step is green.
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

describe("ask-picker compiled dist (src↔dist drift guard)", () => {
	it.skipIf(!distBuilt)("never renders a line wider than the terminal", async () => {
		const { initTheme } = await import(distThemeUrl.href);
		const { createAskPicker } = await import(distComponentsUrl.href);
		initTheme(undefined, false);

		for (const width of [40, 80, 120]) {
			const { component } = createAskPicker(adversarialReq(), () => {});
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});
