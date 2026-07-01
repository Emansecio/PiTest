import { Text } from "@pit/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const ERROR_WITH_HINTS =
	"ENOENT: no such file or directory, access 'missing.md'\n\n" +
	'[hint] File not found. Locate it with `find({pattern:"**/SKILL.md"})`.\n' +
	"[hint] Second recovery line for collapse test.";

function renderReadError(expanded: boolean): string {
	const def = createReadToolDefinition(process.cwd());
	const renderResult = def.renderResult;
	if (!renderResult) throw new Error("read renderResult missing");
	const text = new Text("", 0, 0);
	renderResult(
		{ content: [{ type: "text", text: ERROR_WITH_HINTS }], details: undefined },
		{ expanded, isPartial: false },
		theme,
		{
			args: { path: "missing.md" },
			toolCallId: "read-1",
			invalidate: () => {},
			lastComponent: text,
			state: {},
			cwd: process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded,
			showImages: false,
			isError: true,
			activityChild: false,
		},
	);
	return stripAnsi(text.render(120).join("\n"));
}

describe("read error hint collapse", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("collapsed error hides extra hint lines behind a trailer", () => {
		const rendered = renderReadError(false);
		expect(rendered).toContain("ENOENT");
		expect(rendered).toContain("[hint] File not found");
		expect(rendered).not.toContain("Second recovery line");
		expect(rendered).toMatch(/hint lines.*expand/i);
	});

	test("expanded error shows the full hint block", () => {
		const rendered = renderReadError(true);
		expect(rendered).toContain("Second recovery line for collapse test");
		expect(rendered).not.toMatch(/hint lines.*expand/i);
	});
});
