/**
 * Session recovery injects error reflection as steer (not followUp) once thrash
 * escalates the session to guided.
 */

import type { AgentTool } from "@pit/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.js";

function customMessages(harness: Harness, customType: string) {
	return harness.session.messages.filter(
		(m) => (m as { role?: string }).role === "custom" && (m as { customType?: string }).customType === customType,
	);
}

function makeConstantErrorTool(name = "repeater"): AgentTool {
	return {
		name,
		label: name,
		description: "Always fails with the same error regardless of args",
		parameters: Type.Object({ n: Type.Optional(Type.Number()) }),
		execute: async () => {
			throw new Error("the same boom every time");
		},
	};
}

describe("session recovery steers", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("injects error reflection as steer after result-loop thrash escalates to guided", async () => {
		const harness = await createHarness({
			tools: [makeConstantErrorTool()],
			settings: { toolFeedback: { errorReflection: { enabled: false } } },
		});
		harnesses.push(harness);

		const failing = fauxAssistantMessage([fauxToolCall("repeater", { n: 0 })], { stopReason: "toolUse" });
		harness.setResponses([
			failing,
			fauxAssistantMessage([fauxToolCall("repeater", { n: 1 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("repeater", { n: 2 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("repeater", { n: 3 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("repeater", { n: 4 })], { stopReason: "toolUse" }),
			fauxAssistantMessage("giving up"),
		]);

		await harness.session.prompt("keep trying");

		expect(harness.session.getRecoveryLevel()).not.toBe("lean");
		const reflections = customMessages(harness, "pi.tool-error-reflection");
		expect(reflections.length).toBeGreaterThan(0);
		const narration = customMessages(harness, "pi.session-recovery-narration");
		expect(narration.length).toBe(1);
	});
});
