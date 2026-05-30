import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool, createReadTool } from "../../../src/core/tools/index.js";
import { createHarness, type Harness } from "../harness.js";

describe("unknown tool: did-you-mean error (e2e)", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("includes available tools and a suggestion when the model invents a tool name", async () => {
		const harness = await createHarness({
			tools: [createEditTool(process.cwd()), createReadTool(process.cwd())],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("edit_file", { path: "/x", edits: [] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("rewrite");
		const event = harness.eventsOfType("tool_execution_end").find((e) => e.toolName === "edit_file");
		expect(event?.isError).toBe(true);
		type TextPart = { type: "text"; text: string };
		const text = event?.result.content
			.filter((c: { type: string; text?: string }): c is TextPart => c.type === "text")
			.map((c: TextPart) => c.text)
			.join("\n");
		expect(text).toContain('Tool "edit_file" not found');
		expect(text).toContain("Available tools:");
		expect(text).toContain('Did you mean "edit"?');
	});
});
