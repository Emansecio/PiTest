import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type ThemeFile = {
	vars: Record<string, string | number>;
	colors: Record<string, string | number>;
	export: Record<string, string | number>;
};

const themes = ["dark", "light"] as const;

function loadTheme(name: (typeof themes)[number]): ThemeFile {
	return JSON.parse(
		readFileSync(new URL(`../src/modes/interactive/theme/${name}.json`, import.meta.url), "utf8"),
	) as ThemeFile;
}

function resolveColor(theme: ThemeFile, value: string | number): string {
	if (typeof value === "number") return ansi256ToHex(value);
	return value.startsWith("#") ? value : String(theme.vars[value]);
}

function ansi256ToHex(index: number): string {
	if (index < 16) {
		return [
			"#000000",
			"#800000",
			"#008000",
			"#808000",
			"#000080",
			"#800080",
			"#008080",
			"#c0c0c0",
			"#808080",
			"#ff0000",
			"#00ff00",
			"#ffff00",
			"#0000ff",
			"#ff00ff",
			"#00ffff",
			"#ffffff",
		][index]!;
	}
	if (index < 232) {
		const n = index - 16;
		const channel = (part: number) => (part === 0 ? 0 : 55 + part * 40).toString(16).padStart(2, "0");
		return `#${channel(Math.floor(n / 36))}${channel(Math.floor((n % 36) / 6))}${channel(n % 6)}`;
	}
	const gray = (8 + (index - 232) * 10).toString(16).padStart(2, "0");
	return `#${gray}${gray}${gray}`;
}

function luminance(hex: string): number {
	const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
	const linear = (channel: number) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
	return 0.2126 * linear(channels[0]!) + 0.7152 * linear(channels[1]!) + 0.0722 * linear(channels[2]!);
}

function contrast(foreground: string, background: string): number {
	const light = Math.max(luminance(foreground), luminance(background));
	const dark = Math.min(luminance(foreground), luminance(background));
	return (light + 0.05) / (dark + 0.05);
}

describe("actionable theme contrast", () => {
	it.each(themes)("keeps muted guidance readable in %s", (name) => {
		const theme = loadTheme(name);
		const muted = resolveColor(theme, theme.colors.muted);
		const pageBg = resolveColor(theme, theme.export.pageBg);
		const cardBg = resolveColor(theme, theme.export.cardBg);

		expect(contrast(muted, pageBg)).toBeGreaterThanOrEqual(4.5);
		expect(contrast(muted, cardBg)).toBeGreaterThanOrEqual(4.5);
	});

	it.each(themes)("keeps selected text readable in %s", (name) => {
		const theme = loadTheme(name);
		const text = resolveColor(theme, theme.colors.text);
		const selectedBg = resolveColor(theme, theme.colors.selectedBg);
		expect(contrast(text, selectedBg)).toBeGreaterThanOrEqual(4.5);
	});
});
