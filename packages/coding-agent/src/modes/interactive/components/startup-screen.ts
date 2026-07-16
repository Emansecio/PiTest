import { type Component, truncateToWidth, visibleWidth } from "@pit/tui";
import { heroWordmarkGradient } from "../theme/color-interpolation.ts";
import { theme } from "../theme/theme.ts";
import { HERO_PIT, HERO_WIDTH } from "./welcome-box.ts";

function center(line: string, width: number): string {
	const fitted = visibleWidth(line) > width ? truncateToWidth(line, width) : line;
	return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(fitted)) / 2))) + fitted;
}

/** The block "PIT" wordmark, gradient-painted row by row (teal → lavender). */
function wordmarkRows(): string[] {
	return HERO_PIT.map((raw, i) => heroWordmarkGradient(i, HERO_PIT.length)(raw));
}

export class StartupScreen implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		try {
			const welcome = theme.fg("accent", "Welcome to Pit");
			const help = theme.fg("muted", "/help for help");
			const lines: string[] = [];

			const showLogo = safeWidth >= HERO_WIDTH;
			const logo = showLogo ? wordmarkRows() : [];
			const sideBySide = safeWidth >= 58 && showLogo;

			if (sideBySide) {
				const gap = 4;
				const textWidth = Math.max(visibleWidth("Welcome to Pit"), visibleWidth("/help for help"));
				const blockWidth = HERO_WIDTH + gap + textWidth;
				const leftPad = " ".repeat(Math.max(0, Math.floor((safeWidth - blockWidth) / 2)));
				const textStart = Math.max(0, Math.floor(logo.length / 2) - 1);
				for (let row = 0; row < logo.length; row++) {
					const glyph = logo[row] ?? "";
					const glyphPad = " ".repeat(Math.max(0, HERO_WIDTH - visibleWidth(glyph)));
					let text = "";
					if (row === textStart) text = welcome;
					else if (row === textStart + 1) text = help;
					lines.push(truncateToWidth(`${leftPad}${glyph}${glyphPad}${" ".repeat(gap)}${text}`, safeWidth));
				}
			} else {
				for (const line of logo) {
					const pad = " ".repeat(Math.max(0, HERO_WIDTH - visibleWidth(line)));
					lines.push(center(line + pad, safeWidth));
				}
				if (logo.length > 0) lines.push("");
				lines.push(center(welcome, safeWidth));
				lines.push(center(help, safeWidth));
			}

			lines.push(theme.fg("dim", "─".repeat(safeWidth)));
			return lines;
		} catch {
			return [theme.fg("warning", "Startup screen unavailable"), theme.fg("dim", "─".repeat(safeWidth))];
		}
	}
}
