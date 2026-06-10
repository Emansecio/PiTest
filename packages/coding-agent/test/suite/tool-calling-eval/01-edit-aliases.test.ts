import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../../../src/core/tools/index.js";
import { createHarness, type Harness } from "../harness.js";

/**
 * End-to-end coverage for the alias absorption layer in the `edit` tool. The
 * faux provider emits the same broken shapes we have seen real models produce;
 * the harness must normalize them BEFORE TypeBox validation rejects the call.
 */
describe("edit tool: alias and shape normalization (e2e)", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
		// 30s: cleanup under full-suite contention on Windows can exceed the 10s default.
	}, 30_000);

	async function makeHarness() {
		// Build the edit tool against a temp dir we don't yet know; the harness
		// uses `tools` as a base-tool override map keyed by name, so we pass a
		// placeholder cwd that we'll never read from (the tool resolves paths
		// against its own cwd argument anyway).
		const tmpPlaceholder = process.cwd();
		const harness = await createHarness({ tools: [createEditTool(tmpPlaceholder)] });
		harnesses.push(harness);
		return { harness };
	}

	it("accepts file_path as an alias for path", async () => {
		const { harness } = await makeHarness();
		const file = join(harness.tempDir, "a.txt");
		writeFileSync(file, "alpha\n");

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						file_path: file,
						edits: [{ oldText: "alpha", newText: "beta" }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("rewrite");

		const ends = harness.eventsOfType("tool_execution_end");
		const editEnd = ends.find((event) => event.toolName === "edit");
		expect(editEnd?.isError).toBe(false);
		expect(readFileSync(file, "utf8")).toBe("beta\n");
	});

	it("parses edits passed as a JSON-encoded string", async () => {
		const { harness } = await makeHarness();
		const file = join(harness.tempDir, "b.txt");
		writeFileSync(file, "first\n");

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: file,
						edits: JSON.stringify([{ oldText: "first", newText: "second" }]),
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("rewrite");

		const editEnd = harness.eventsOfType("tool_execution_end").find((event) => event.toolName === "edit");
		expect(editEnd?.isError).toBe(false);
		expect(readFileSync(file, "utf8")).toBe("second\n");
	});
});
