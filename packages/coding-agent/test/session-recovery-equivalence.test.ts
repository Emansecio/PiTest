/**
 * Lean session with no thrash must not inject recovery-only steers.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/index.js";
import { createHarness, type Harness } from "./suite/harness.js";

function customTypes(harness: Harness): string[] {
	return harness.session.messages
		.filter((m) => (m as { role?: string }).role === "custom")
		.map((m) => (m as { customType?: string }).customType ?? "");
}

describe("session recovery lean equivalence", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("clean successful edit stays lean with no recovery steers", async () => {
		const harness = await createHarness({
			tools: [createEditTool(process.cwd())],
			settings: { toolFeedback: { errorReflection: { enabled: false } } },
		});
		harnesses.push(harness);
		const file = join(harness.tempDir, "ok.txt");
		writeFileSync(file, "alpha\n");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", { path: file, edits: [{ oldText: "alpha", newText: "beta" }] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("rewrite");

		expect(harness.session.getRecoveryLevel()).toBe("lean");
		expect(customTypes(harness)).not.toContain("pi.tool-error-reflection");
		expect(customTypes(harness)).not.toContain("pi.session-recovery-narration");
		expect(readFileSync(file, "utf8")).toBe("beta\n");
	});
});
