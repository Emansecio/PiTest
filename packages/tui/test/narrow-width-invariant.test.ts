/**
 * A component must never render a line wider than the width it was given —
 * `TUI.doRender` treats that as fatal (see `assertComponentWidth`).
 *
 * `Text` and `Markdown` floored the CONTENT at one column but still appended
 * both margins, so any width below `2 * paddingX + 1` produced a line of
 * `1 + 2*paddingX` columns. Assistant prose runs at `paddingX: 2` inside a
 * 2-column shell, so this started at roughly six columns of terminal — rare, but
 * survivable only because `clampLineToWidth` truncated it further downstream.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.js";
import { Text } from "../src/components/text.js";
import { visibleWidth } from "../src/utils.js";
import { defaultMarkdownTheme } from "./test-themes.js";

const SAMPLES = ["hello world", "日本語のテキスト", "a", "mixed 日本 text with ascii"];

describe("narrow-width invariant", () => {
	it("Text never exceeds the width it was given", () => {
		for (const paddingX of [0, 1, 2, 4]) {
			for (const sample of SAMPLES) {
				for (let width = 1; width <= 12; width++) {
					for (const line of new Text(sample, paddingX, 0).render(width)) {
						assert.ok(
							visibleWidth(line) <= width,
							`Text(pad=${paddingX}) at width ${width} produced ${visibleWidth(line)}: ${JSON.stringify(line)}`,
						);
					}
				}
			}
		}
	});

	it("Markdown never exceeds the width it was given", () => {
		for (const paddingX of [0, 1, 2, 4]) {
			for (const sample of SAMPLES) {
				for (let width = 1; width <= 12; width++) {
					for (const line of new Markdown(sample, paddingX, 0, defaultMarkdownTheme).render(width)) {
						assert.ok(
							visibleWidth(line) <= width,
							`Markdown(pad=${paddingX}) at width ${width} produced ${visibleWidth(line)}: ${JSON.stringify(line)}`,
						);
					}
				}
			}
		}
	});

	it("Markdown with a background + prose cap never exceeds the width it was given", () => {
		// The cap/background path charged the RAW paddingX in its width arithmetic
		// while the margins used the clamped `pad`: at widths below 2*paddingX+1 the
		// background line came out wider than the terminal (fatal via
		// assertComponentWidth in dev, a truncated-bg artifact in prod).
		const bgColor = (text: string) => `\x1b[41m${text}\x1b[49m`;
		for (const paddingX of [1, 2, 4]) {
			for (const sample of SAMPLES) {
				for (let width = 1; width <= 12; width++) {
					const md = new Markdown(sample, paddingX, 0, defaultMarkdownTheme, { bgColor }, 100);
					for (const line of md.render(width)) {
						assert.ok(
							visibleWidth(line) <= width,
							`Markdown(pad=${paddingX}, bg, cap=100) at width ${width} produced ${visibleWidth(line)}: ${JSON.stringify(line)}`,
						);
					}
				}
			}
		}
	});
});
