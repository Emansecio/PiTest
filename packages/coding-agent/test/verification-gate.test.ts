/**
 * Integration test for the native verification gate: after a turn that modifies
 * a file, the session runs the project check and (on failure) re-injects the
 * output so the agent self-corrects, bounded by maxAttempts.
 */

import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.js";

const NODE_OK = `node -e "process.exit(0)"`;
const NODE_FAIL = `node -e "process.exit(1)"`;

describe("verification gate", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("runs the check after a file-modifying turn and stays silent when it passes", async () => {
		const harness = await createHarness({ settings: { verification: { command: NODE_OK, maxAttempts: 2 } } });
		harnesses.push(harness);
		const file = join(harness.tempDir, "out.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("wrote it"),
		]);

		await harness.session.prompt("create out.txt");

		const v = harness.eventsOfType("verification");
		expect(v.some((e) => e.phase === "passed")).toBe(true);
		// No fix prompt injected when the check is green.
		expect(getUserTexts(harness)).toEqual(["create out.txt"]);
	});

	it("re-injects the failure and gives up after maxAttempts", async () => {
		const harness = await createHarness({ settings: { verification: { command: NODE_FAIL, maxAttempts: 1 } } });
		harnesses.push(harness);
		const file = join(harness.tempDir, "out.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("wrote it"),
			// The injected fix turn (the gate re-prompts once before giving up).
			fauxAssistantMessage("tried to fix it"),
		]);

		await harness.session.prompt("create out.txt");

		const failed = harness.eventsOfType("verification").filter((e) => e.phase === "failed");
		expect(failed.length).toBeGreaterThanOrEqual(1);
		// The check output was re-injected as a user message.
		expect(getUserTexts(harness).some((t) => t.includes("isn't verified yet"))).toBe(true);
		// The last failure gave up rather than looping forever.
		expect(failed[failed.length - 1].willRetry).toBe(false);
	});

	it("is inert when the turn modified no files", async () => {
		const harness = await createHarness({ settings: { verification: { command: NODE_FAIL, maxAttempts: 2 } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("just talking, no edits")]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("verification")).toEqual([]);
	});

	it("runs the check after a turn that mutates only through an effectful bash command", async () => {
		const harness = await createHarness({ settings: { verification: { command: NODE_OK, maxAttempts: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			// `node ...` is not a known read-only command, so classifyBashCommand
			// taints it to "action" — a mutation the path-based extractor never saw.
			fauxAssistantMessage([fauxToolCall("bash", { command: NODE_OK })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ran the script"),
		]);

		await harness.session.prompt("run a build step");

		expect(harness.eventsOfType("verification").some((e) => e.phase === "passed")).toBe(true);
	});

	it("stays inert after a read-only bash command (no mutation to verify)", async () => {
		const harness = await createHarness({ settings: { verification: { command: NODE_FAIL, maxAttempts: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			// `echo` is read-only → classified as navigation → the gate must not arm.
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("just looked around"),
		]);

		await harness.session.prompt("inspect the repo");

		expect(harness.eventsOfType("verification")).toEqual([]);
	});

	it("is inert when disabled", async () => {
		const harness = await createHarness({ settings: { verification: { enabled: false, command: NODE_FAIL } } });
		harnesses.push(harness);
		const file = join(harness.tempDir, "out.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("wrote it"),
		]);

		await harness.session.prompt("create out.txt");

		expect(harness.eventsOfType("verification")).toEqual([]);
	});
});
