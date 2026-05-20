import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool, createReadTool } from "../../../src/core/tools/index.js";
import { createHarness, type Harness } from "../harness.js";

describe("AgentSession.getToolCallStats (e2e)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("counts calls and errors per tool across a session", async () => {
		const harness = await createHarness({
			tools: [createEditTool(process.cwd()), createReadTool(process.cwd())],
		});
		harnesses.push(harness);

		const file = join(harness.tempDir, "a.txt");
		writeFileSync(file, "alpha\n");

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("read", { path: file }),
					fauxToolCall("edit", {
						path: file,
						edits: [{ oldText: "missing", newText: "y" }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const stats = harness.session.getToolCallStats();
		const editStat = stats.find((s) => s.tool === "edit");
		const readStat = stats.find((s) => s.tool === "read");

		expect(readStat).toMatchObject({ calls: 1, errors: 0 });
		expect(editStat).toMatchObject({ calls: 1, errors: 1 });
		expect(editStat?.topErrors[0]?.message).toMatch(/Could not find/);
	});
});
