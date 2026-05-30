import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../../../src/core/tools/index.js";
import { createHarness, type Harness } from "../harness.js";

describe("edit tool: near-miss + indent-tolerant tiers (e2e)", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	async function makeHarness() {
		const harness = await createHarness({ tools: [createEditTool(process.cwd())] });
		harnesses.push(harness);
		return harness;
	}

	function getEditEndError(harness: Harness): string {
		const event = harness.eventsOfType("tool_execution_end").find((e) => e.toolName === "edit" && e.isError);
		if (!event) return "";
		type TextPart = { type: "text"; text: string };
		return event.result.content
			.filter((c: { type: string; text?: string }): c is TextPart => c.type === "text")
			.map((c: TextPart) => c.text)
			.join("\n");
	}

	it("returns a near-miss hint when oldText is close but wrong", async () => {
		const harness = await makeHarness();
		const file = join(harness.tempDir, "src.ts");
		writeFileSync(file, "function foo() {\n  return 1;\n  return 2;\n}\n");

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: file,
						edits: [
							{
								oldText: "function foo() {\n  return 999;\n  return 2;\n}",
								newText: "function foo() {\n  return 7;\n  return 2;\n}",
							},
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("rewrite");
		const errorText = getEditEndError(harness);
		expect(errorText).toMatch(/first divergence at line 2/i);
		// Candidate now ships a copy-pasteable verbatim oldText so the model
		// can recover without guessing whitespace or surrounding context.
		expect(errorText).toContain("Paste this verbatim as oldText");
		expect(errorText).toContain("return 1;");
		expect(errorText).toContain("return 2;");
	});

	it("recovers via indent-tolerant tier when only leading whitespace differs", async () => {
		const harness = await makeHarness();
		const file = join(harness.tempDir, "src.ts");
		writeFileSync(file, "function foo() {\n\treturn 1;\n}\n");

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: file,
						edits: [
							{
								oldText: "function foo() {\n    return 1;\n}",
								newText: "function foo() {\n    return 99;\n}",
							},
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("rewrite");
		const ends = harness.eventsOfType("tool_execution_end");
		expect(ends.find((e) => e.toolName === "edit")?.isError).toBe(false);
		expect(readFileSync(file, "utf8")).toBe("function foo() {\n\treturn 99;\n}\n");
	});
});
