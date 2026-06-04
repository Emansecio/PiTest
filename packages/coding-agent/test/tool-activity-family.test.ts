import { describe, expect, test } from "vitest";
import { createToolDefinition } from "../src/core/tools/index.js";

const NAVIGATION = [
	"read",
	"grep",
	"find",
	"ls",
	"symbol",
	"ast_grep",
	"search_tool_bm25",
	"recall",
	"reflect",
	"recipe",
	"calc",
	"inspect_image",
	"chrome_devtools_list_pages",
	"chrome_devtools_screenshot",
	"chrome_devtools_read_console",
	"chrome_devtools_read_network",
] as const;

const ACTION = ["edit", "write", "bash", "ast_edit", "web_search", "todo"] as const;

describe("tool activity family on built-in definitions", () => {
	test.each(NAVIGATION)("%s is navigation", (name) => {
		expect(createToolDefinition(name as any, process.cwd()).activity).toBe("navigation");
	});

	test.each(ACTION)("%s defaults to action (undefined)", (name) => {
		expect(createToolDefinition(name as any, process.cwd()).activity).toBeUndefined();
	});
});
