import { visibleWidth } from "@pit/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { clampBashCommandRow } from "../src/modes/interactive/components/bash-command-row.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

describe("clampBashCommandRow", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("shows a short command as-is, with no hint or ellipsis", () => {
		const row = stripAnsi(clampBashCommandRow({ command: "ls -la", width: 80, colorKey: "toolTitle" }));
		expect(row).toContain("$ ls -la");
		expect(row).not.toContain("…");
		expect(row).not.toContain("to expand");
		expect(row).not.toContain("earlier lines");
	});

	it("folds extra command lines plus extraHidden into the line count", () => {
		// 3-line command (2 extra) + 2 hidden output lines = 4 earlier lines.
		const row = stripAnsi(
			clampBashCommandRow({ command: "first\nsecond\nthird", width: 120, colorKey: "toolTitle", extraHidden: 2 }),
		);
		expect(row).toContain("$ first");
		expect(row).toContain("4 earlier lines");
		expect(row).toContain("to expand");
		// Only the first command line is rendered; the rest are folded away.
		expect(row).not.toContain("second");
		expect(row).not.toContain("third");
	});

	it("counts only hidden output when the command is single-line", () => {
		const row = stripAnsi(
			clampBashCommandRow({ command: "echo hi", width: 120, colorKey: "bashMode", extraHidden: 5 }),
		);
		expect(row).toContain("$ echo hi");
		expect(row).toContain("5 earlier lines");
	});

	it("clips a long single-line command horizontally with an ellipsis and a bare expand hint", () => {
		const long = `grep -rIn "github" --exclude-dir=.git --exclude-dir=.claude . | grep -v "CHANGELOG.md" | wc -l`;
		const width = 60;
		const row = clampBashCommandRow({ command: long, width, colorKey: "toolTitle" });
		const plain = stripAnsi(row);

		// Stays within the requested width and on a single row.
		expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		expect(plain).not.toContain("\n");
		// Horizontal clip → ellipsis + bare affordance, no line count.
		expect(plain).toContain("…");
		expect(plain).toContain("to expand");
		expect(plain).not.toContain("earlier lines");
		// The clipped tail is gone.
		expect(plain).not.toContain("wc -l");
	});

	it("reserves room for and appends a styled suffix (e.g. timeout)", () => {
		const suffix = " (timeout 30s)";
		const row = clampBashCommandRow({ command: "sleep 60", width: 80, colorKey: "toolTitle", suffix });
		const plain = stripAnsi(row);
		expect(plain).toContain("$ sleep 60");
		expect(plain).toContain("(timeout 30s)");
		expect(visibleWidth(row)).toBeLessThanOrEqual(80);
	});

	it("keeps the suffix and hint visible when a long command is clipped", () => {
		const long = "x".repeat(200);
		const suffix = " (timeout 5s)";
		const width = 50;
		const row = clampBashCommandRow({ command: long, width, colorKey: "bashMode", suffix });
		const plain = stripAnsi(row);
		expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		expect(plain).toContain("(timeout 5s)");
		expect(plain).toContain("to expand");
		expect(plain).toContain("…");
	});

	it("never exceeds the width nor wraps, even when narrower than the hint", () => {
		const long = "x".repeat(200);
		// width smaller than the expand hint + suffix → both get dropped, command
		// alone clipped to the full width. Must stay a single row within bounds.
		for (const width of [1, 4, 8, 12]) {
			const row = clampBashCommandRow({
				command: long,
				width,
				colorKey: "toolTitle",
				extraHidden: 9,
				suffix: " (timeout 5s)",
			});
			expect(visibleWidth(row), `width=${width}`).toBeLessThanOrEqual(width);
			expect(stripAnsi(row)).not.toContain("\n");
		}
	});

	it("returns an empty row at width 0", () => {
		const row = clampBashCommandRow({ command: "echo hi", width: 0, colorKey: "bashMode" });
		expect(visibleWidth(row)).toBe(0);
	});

	it("collapses a long leading `cd <path> &&` so the real command stays visible", () => {
		const command = `cd "C:/Users/User/Desktop/Projetos Vibe Coding/Projeto Fitness" && grep -rli "segunda" .`;
		const row = stripAnsi(clampBashCommandRow({ command, width: 80, colorKey: "toolTitle" }));
		// The absolute path is shortened to its tail…
		expect(row).toContain("…/Projeto Fitness");
		expect(row).not.toContain("C:/Users/User/Desktop");
		// …and the actual command survives instead of being clipped off-screen.
		expect(row).toContain("grep -rli");
	});

	it("leaves a short `cd` path and a command without `cd` untouched", () => {
		const short = stripAnsi(clampBashCommandRow({ command: "cd src && ls", width: 80, colorKey: "toolTitle" }));
		expect(short).toContain("$ cd src && ls");
		const plain = stripAnsi(clampBashCommandRow({ command: "grep -rn foo .", width: 80, colorKey: "toolTitle" }));
		expect(plain).toContain("$ grep -rn foo .");
		expect(plain).not.toContain("…");
	});

	it("omits the `$ ` sigil when prefix:false for compact activity rows", () => {
		const row = stripAnsi(
			clampBashCommandRow({ command: "npm run check", width: 80, colorKey: "toolTitle", prefix: false }),
		);
		expect(row).toBe("npm run check");
		expect(row).not.toContain("$");
	});

	it("keeps the `$ ` sigil by default (user `!` header / standalone tool title)", () => {
		const row = stripAnsi(clampBashCommandRow({ command: "npm run check", width: 80, colorKey: "bashMode" }));
		expect(row).toContain("$ npm run check");
	});

	it("elides a leading `cd <path> &&` when elideCd:true (full command on expand)", () => {
		const row = stripAnsi(
			clampBashCommandRow({
				command: `cd "C:/Users/User/Desktop/Projeto Fitness" && grep -rli "segunda" .`,
				width: 80,
				colorKey: "toolTitle",
				prefix: false,
				elideCd: true,
			}),
		);
		expect(row).toBe(`grep -rli "segunda" .`);
		expect(row).not.toContain("cd ");
	});

	it("leaves a command without a leading `cd` unchanged under elideCd:true", () => {
		const row = stripAnsi(
			clampBashCommandRow({
				command: "grep -rn foo .",
				width: 80,
				colorKey: "toolTitle",
				prefix: false,
				elideCd: true,
			}),
		);
		expect(row).toBe("grep -rn foo .");
	});

	it("strips leading diagnostic echo banners under stripEcho:true", () => {
		const row = stripAnsi(
			clampBashCommandRow({
				command: 'echo "=== branch/status ===" && git status --short',
				width: 80,
				colorKey: "toolTitle",
				prefix: false,
				stripEcho: true,
			}),
		);
		expect(row).toBe("git status --short");
		expect(row).not.toContain("===");
	});

	it("chains stripEcho with elideCd for probe commands", () => {
		const row = stripAnsi(
			clampBashCommandRow({
				command: 'echo "=== grep ===" && cd C:/PiTest && grep -rIn foo .',
				width: 80,
				colorKey: "toolTitle",
				prefix: false,
				stripEcho: true,
				elideCd: true,
			}),
		);
		expect(row).toBe("grep -rIn foo .");
	});

	it("omits inline expand hints when suppressExpandHint:true", () => {
		const long = `grep -rIn "github" --exclude-dir=.git --exclude-dir=.claude . | grep -v "CHANGELOG.md" | wc -l`;
		const row = stripAnsi(
			clampBashCommandRow({
				command: long,
				width: 40,
				colorKey: "toolTitle",
				prefix: false,
				suppressExpandHint: true,
			}),
		);
		expect(row).toContain("…");
		expect(row).not.toContain("to expand");
	});
});
