import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	Markdown,
	type MarkdownTheme,
	SelectList,
	type SelectListTheme,
	truncateToWidth,
	visibleWidth,
} from "@pit/tui";
import { Chalk } from "chalk";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { createAskPicker } from "../src/modes/interactive/components/ask-picker.js";
import { FoldedThinkingText } from "../src/modes/interactive/components/assistant-message.js";
import { HelpOverlay } from "../src/modes/interactive/components/help-overlay.js";
import { StartupScreen, type StartupScreenData } from "../src/modes/interactive/components/startup-screen.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const FIXTURES = join(__dirname, "fixtures", "ui");
const plain = (text: string): string => stripVTControlCharacters(text).replace(/\r/g, "");
const chalk = new Chalk({ level: 0 });
const identity = (text: string): string => text;

const markdownTheme: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

const listTheme: SelectListTheme = {
	selectedPrefix: (text) => chalk.cyan(text),
	selectedText: (text) => chalk.bold(text),
	description: (text) => chalk.dim(text),
	scrollInfo: (text) => chalk.dim(text),
	noMatch: (text) => chalk.dim(text),
	section: (text) => chalk.bold(text),
};

const startupData = (recentSessions: StartupScreenData["recentSessions"]): StartupScreenData => ({
	appName: "pit",
	version: "0.75.4",
	tagline: "your coding companion",
	helpHint: "/help",
	recentSessions,
	petColors: { bg: [12, 14, 18], stroke: [233, 237, 240], eye: [63, 224, 122] },
	petEnabled: false,
	reducedMotion: true,
	rows: 40,
});

function frame(width: number, height: number, themeName: "dark" | "light", body: string[]): string {
	const lines = [
		`pit · ${themeName} · <repo>`,
		"─".repeat(Math.max(1, width)),
		...body,
		"",
		"ctrl+c sair · /help ajuda",
	];
	while (lines.length < height) lines.push("");
	return lines
		.slice(0, height)
		.map((line) => {
			const clipped = truncateToWidth(plain(line), width, "");
			return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
		})
		.join("\n");
}

function startupFrame(width: number, height: number, themeName: "dark" | "light", withSessions: boolean): string {
	initTheme(themeName);
	const sessions = withSessions
		? [
				{ title: "fix terminal freeze", age: "2h" },
				{ title: "repo graph phase 4b", age: "1d" },
				{ title: "polish CLI", age: "3d" },
			]
		: [];
	return frame(width, height, themeName, new StartupScreen({ ...startupData(sessions), rows: height }).render(width));
}

function paletteFrame(width: number, height: number, themeName: "dark" | "light"): string {
	initTheme(themeName);
	const items = [
		{ value: "help", label: "/help", description: "Open command help", section: "ESSENTIAL", badge: "built-in" },
		{
			value: "resume",
			label: "/resume",
			description: "Resume a previous session",
			section: "ESSENTIAL",
			badge: "built-in",
		},
		{ value: "new", label: "/new", description: "Start a new session", section: "ESSENTIAL", badge: "built-in" },
		{ value: "calendar", label: "/calendar", description: "Project command", section: "PROJECT", badge: "extension" },
		{ value: "review", label: "/review", description: "Review changes", section: "PROJECT", badge: "skill" },
	];
	const list = new SelectList(items, Math.max(3, Math.min(12, height - 7)), listTheme, {
		showKeyHints: true,
	});
	return frame(width, height, themeName, list.render(width));
}

function helpFrame(width: number, height: number, themeName: "dark" | "light"): string {
	initTheme(themeName);
	const overlay = new HelpOverlay(
		"# Slash commands\n\n- `/help` — show this guide\n- `/resume` — reopen a session\n- `/new` — start a clean session\n\nUse ↑/↓ to scroll and Esc to close.",
		markdownTheme,
		{ title: identity, hint: identity },
		() => {},
		() => height,
	);
	return frame(width, height, themeName, overlay.render(width));
}

function thinkingFrame(width: number, height: number, themeName: "dark" | "light", expanded: boolean): string {
	initTheme(themeName);
	const markdown = new Markdown(
		"line one\nline two\nline three\nline four\nline five\nline six\nline seven\nline eight",
		0,
		0,
		markdownTheme,
	);
	const thinking = new FoldedThinkingText(markdown, () => true);
	thinking.setExpanded(expanded);
	return frame(width, height, themeName, thinking.render(width));
}

function askFrame(width: number, height: number, themeName: "dark" | "light"): string {
	initTheme(themeName);
	const { component } = createAskPicker(
		{
			requestId: "ui-golden",
			question: "What should happen next?",
			header: "Permission",
			options: [
				{ label: "Allow once", description: "Continue this operation", recommended: true },
				{ label: "Deny", description: "Stop and return to the editor" },
			],
			source: { toolName: "read" },
		},
		() => {},
	);
	return frame(width, height, themeName, component.render(width));
}

type ScreenTheme = "dark" | "light";
type ScreenRenderer = (width: number, height: number, themeName: ScreenTheme) => string;

const cases: Array<{ id: string; widths: number[]; heights: number[]; render: ScreenRenderer }> = [
	{ id: "startup-empty", widths: [40, 80], heights: [12, 24], render: (w, h, t) => startupFrame(w, h, t, false) },
	{ id: "startup-sessions", widths: [40, 80], heights: [12, 24], render: (w, h, t) => startupFrame(w, h, t, true) },
	{ id: "palette", widths: [40, 80, 120], heights: [12, 24, 40], render: (w, h, t) => paletteFrame(w, h, t) },
	{ id: "help", widths: [40, 80], heights: [12, 24], render: (w, h, t) => helpFrame(w, h, t) },
	{ id: "thinking-folded", widths: [40, 80], heights: [12, 24], render: (w, h, t) => thinkingFrame(w, h, t, false) },
	{ id: "thinking-expanded", widths: [40, 80], heights: [12, 24], render: (w, h, t) => thinkingFrame(w, h, t, true) },
	{ id: "permission-picker", widths: [40, 80], heights: [12, 24], render: (w, h, t) => askFrame(w, h, t) },
	{
		id: "tool-pending",
		widths: [40, 80, 120],
		heights: [12, 24, 40],
		render: (w, h, t) => frame(w, h, t, ["╭─ tool · pending", "│ read src/app.ts", "╰─ waiting for result"]),
	},
	{
		id: "tool-success",
		widths: [40, 80, 120],
		heights: [12, 24, 40],
		render: (w, h, t) => frame(w, h, t, ["╭─ tool · success", "│ read src/app.ts", "╰─ 12 lines"]),
	},
	{
		id: "tool-error",
		widths: [40, 80, 120],
		heights: [12, 24, 40],
		render: (w, h, t) => frame(w, h, t, ["╭─ tool · error", "│ read src/app.ts", "╰─ permission denied"]),
	},
	{
		id: "footer-normal",
		widths: [40, 80, 120],
		heights: [12, 24, 40],
		render: (w, h, t) => frame(w, h, t, ["model · ready", "ctrl+o tools · ctrl+c interrupt"]),
	},
	{
		id: "footer-critical",
		widths: [40, 80, 120],
		heights: [12, 24, 40],
		render: (w, h, t) => frame(w, h, t, ["model · offline", "permission required · Esc cancel"]),
	},
] as const;

const fixtureCases = [
	["startup-empty-dark-40x12", () => startupFrame(40, 12, "dark", false)],
	["palette-dark-80x24", () => paletteFrame(80, 24, "dark")],
	["help-dark-80x24", () => helpFrame(80, 24, "dark")],
	["thinking-folded-light-40x12", () => thinkingFrame(40, 12, "light", false)],
] as const;

afterEach(() => initTheme("dark"));

describe("interactive screen visual goldens", () => {
	it("covers the deterministic full-screen matrix without terminal-size coupling", () => {
		for (const testCase of cases) {
			for (const themeName of ["dark", "light"] as const) {
				for (const width of testCase.widths) {
					for (const height of testCase.heights) {
						const rendered = testCase.render(width, height, themeName);
						const lines = rendered.split("\n");
						expect(lines, `${testCase.id} ${themeName} ${width}x${height}`).toHaveLength(height);
						for (const line of lines) {
							expect(visibleWidth(line)).toBe(width);
							expect(line).not.toContain("\x1b]");
						}
						expect(rendered).not.toContain(process.cwd());
					}
				}
			}
		}
	});

	it.each(fixtureCases)("matches the reviewed golden frame: %s", (id, render) => {
		const expected = readFileSync(join(FIXTURES, `${id}.txt`), "utf8").trimEnd();
		const trimPadding = (text: string): string =>
			text
				.split("\n")
				.map((line) => line.trimEnd())
				.join("\n")
				.trimEnd();
		expect(trimPadding(render())).toBe(trimPadding(expected));
	});

	it("keeps CLI parsing out of the visual fixture surface", () => {
		expect(parseArgs(["--help"]).help).toBe(true);
		expect(parseArgs(["--provider", "openai"]).diagnostics).toEqual([]);
	});

	it("filters the command help overlay and keeps origin metadata visible", () => {
		initTheme("dark");
		const overlay = new HelpOverlay(
			[
				{ name: "help", description: "Show help", group: "Session", badge: "built-in" },
				{ name: "resume", description: "Resume a session", group: "Session", badge: "built-in" },
				{ name: "review", description: "Review changes", group: "Project", badge: "skill" },
			],
			markdownTheme,
			{ title: identity, hint: identity },
			() => {},
			() => 24,
		);
		overlay.focused = true;
		overlay.handleInput("r");
		const rendered = overlay.render(80).map(plain).join("\n");

		expect(rendered).toContain("/resume");
		expect(rendered).not.toContain("/help");
		expect(rendered).toContain("[built-in]");
	});

	it("truncates the legacy help hint on narrow overlays", () => {
		const overlay = new HelpOverlay(
			Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"),
			markdownTheme,
			{ title: identity, hint: identity },
			() => {},
			() => 24,
		);

		for (const line of overlay.render(30)) {
			expect(visibleWidth(plain(line))).toBeLessThanOrEqual(30);
		}
	});
});
