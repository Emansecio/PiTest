import { describe, expect, it } from "vitest";
import { parseMcpToolName } from "../src/modes/interactive/components/tool-activity.ts";

describe("parseMcpToolName", () => {
	it("parses server__tool", () => {
		expect(parseMcpToolName("github__list_issues")).toEqual({
			server: "github",
			tool: "list_issues",
		});
	});

	it("parses server.tool with a single dot", () => {
		expect(parseMcpToolName("burp.scan")).toEqual({ server: "burp", tool: "scan" });
	});

	it("returns null for built-in names", () => {
		expect(parseMcpToolName("read")).toBeNull();
		expect(parseMcpToolName("edit_v2")).toBeNull();
		expect(parseMcpToolName("path/to/file")).toBeNull();
	});
});
