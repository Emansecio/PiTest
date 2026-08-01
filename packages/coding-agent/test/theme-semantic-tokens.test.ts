import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEditorTheme, getMarkdownTheme, initTheme, setTheme, theme } from "../src/modes/interactive/theme/theme.js";

type ThemeFile = {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
};

function loadDarkThemeJson(): ThemeFile {
	return JSON.parse(
		readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
	) as ThemeFile;
}

/**
 * Semantic text tokens (`command`, `mdHeading3`, `compactionLabel`) are newer
 * OPTIONAL palette entries: custom themes written before they existed must keep
 * rendering with the token each slot historically borrowed (command → border,
 * mdHeading3 → customMessageLabel, compactionLabel → borderAccent).
 */
describe("semantic theme tokens", () => {
	let tempRoot: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-theme-semantic-"));
		previousAgentDir = process.env.PIT_CODING_AGENT_DIR;
		process.env.PIT_CODING_AGENT_DIR = join(tempRoot, "agent");
		mkdirSync(join(process.env.PIT_CODING_AGENT_DIR, "themes"), { recursive: true });
		initTheme("dark", false);
	});

	afterEach(() => {
		// Restore the built-in palette so the shared global theme never leaks a
		// custom test palette into other suites in this worker.
		initTheme("dark", false);
		rmSync(tempRoot, { recursive: true, force: true });
		if (previousAgentDir === undefined) {
			delete process.env.PIT_CODING_AGENT_DIR;
		} else {
			process.env.PIT_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	function writeCustomTheme(themeJson: ThemeFile): void {
		writeFileSync(
			join(process.env.PIT_CODING_AGENT_DIR!, "themes", `${themeJson.name}.json`),
			JSON.stringify(themeJson, null, 2),
		);
	}

	it("built-in dark defines the semantic tokens with the historical values", () => {
		expect(theme.hasColor("command")).toBe(true);
		expect(theme.hasColor("mdHeading3")).toBe(true);
		expect(theme.hasColor("compactionLabel")).toBe(true);
		// Same values the slots borrowed before the tokens existed.
		expect(theme.getFgAnsi("command")).toBe(theme.getFgAnsi("border"));
		expect(theme.getFgAnsi("mdHeading3")).toBe(theme.getFgAnsi("customMessageLabel"));
		expect(theme.getFgAnsi("compactionLabel")).toBe(theme.getFgAnsi("borderAccent"));
	});

	it("custom theme WITHOUT the new tokens falls back to the old colors", () => {
		const dark = loadDarkThemeJson();
		const legacy: ThemeFile = {
			...dark,
			name: "legacy-no-semantic",
			colors: { ...dark.colors },
		};
		delete legacy.colors.command;
		delete legacy.colors.mdHeading3;
		delete legacy.colors.compactionLabel;
		writeCustomTheme(legacy);

		const result = setTheme("legacy-no-semantic", false);
		expect(result.success).toBe(true);
		expect(theme.hasColor("command")).toBe(false);
		expect(theme.hasColor("mdHeading3")).toBe(false);
		expect(theme.hasColor("compactionLabel")).toBe(false);

		// commandColor renders exactly as `border` used to.
		expect(getEditorTheme().commandColor!("/model")).toBe(theme.fg("border", "/model"));
		// heading3 renders exactly as `customMessageLabel` used to.
		expect(getMarkdownTheme().heading3!("Title")).toBe(theme.bold(theme.fg("customMessageLabel", "Title")));
	});

	it("custom theme WITH the new tokens uses them instead of the borrowed slots", () => {
		const dark = loadDarkThemeJson();
		const custom: ThemeFile = {
			...dark,
			name: "custom-semantic",
			colors: {
				...dark.colors,
				command: "#112233",
				mdHeading3: "#445566",
			},
		};
		writeCustomTheme(custom);

		const result = setTheme("custom-semantic", false);
		expect(result.success).toBe(true);
		expect(getEditorTheme().commandColor!("/model")).toBe(theme.fg("command", "/model"));
		expect(getEditorTheme().commandColor!("/model")).not.toBe(theme.fg("border", "/model"));
		expect(getMarkdownTheme().heading3!("Title")).toBe(theme.bold(theme.fg("mdHeading3", "Title")));
		expect(getMarkdownTheme().heading3!("Title")).not.toBe(theme.bold(theme.fg("customMessageLabel", "Title")));
	});
});
