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
// Fails until a sentinel file exists in cwd (the check runs with cwd = tempDir),
// so a fix turn that writes it flips the check green on the next attempt.
const NODE_FAIL_UNTIL_SENTINEL = `node -e "process.exit(require('fs').existsSync('sentinel.txt')?0:1)"`;
const TERMINAL_MARKER = "Do NOT report the task as done";
const CONTRADICTION_MARKER = "directly contradicts the still-failing check";

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

	it("re-injects the failure, then communicates terminally after exhausting maxAttempts", async () => {
		const harness = await createHarness({ settings: { verification: { command: NODE_FAIL, maxAttempts: 1 } } });
		harnesses.push(harness);
		const file = join(harness.tempDir, "out.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("wrote it"),
			// The injected fix turn (the gate re-prompts once before giving up).
			fauxAssistantMessage("tried to fix it"),
			// The terminal turn: the model responds to the "still red, don't claim done" message.
			fauxAssistantMessage("here is an honest summary of what is still broken"),
		]);

		await harness.session.prompt("create out.txt");

		const failed = harness.eventsOfType("verification").filter((e) => e.phase === "failed");
		expect(failed.length).toBeGreaterThanOrEqual(1);
		const userTexts = getUserTexts(harness);
		// The fix prompt was injected first.
		expect(userTexts.some((t) => t.includes("isn't verified yet"))).toBe(true);
		// On exhaustion the gate no longer ends silently: a TERMINAL message is injected.
		expect(userTexts.some((t) => t.includes(TERMINAL_MARKER))).toBe(true);
		// The terminal message is distinct from the fix prompt (does not ask for another fix).
		const terminal = userTexts.find((t) => t.includes(TERMINAL_MARKER)) ?? "";
		expect(terminal.includes("isn't verified yet")).toBe(false);
		// The last failure gave up rather than looping forever.
		expect(failed[failed.length - 1].willRetry).toBe(false);
	});

	it("does NOT inject a terminal message when a fix lands within maxAttempts", async () => {
		const harness = await createHarness({
			settings: { verification: { command: NODE_FAIL_UNTIL_SENTINEL, maxAttempts: 2 } },
		});
		harnesses.push(harness);
		const file = join(harness.tempDir, "out.txt");
		const sentinel = join(harness.tempDir, "sentinel.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("wrote it"),
			// Fix turn: write the sentinel so the next check attempt passes.
			fauxAssistantMessage([fauxToolCall("write", { path: sentinel, content: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("fixed it"),
		]);

		await harness.session.prompt("create out.txt");

		const v = harness.eventsOfType("verification");
		// The check went green within the budget.
		expect(v.some((e) => e.phase === "passed")).toBe(true);
		const userTexts = getUserTexts(harness);
		// The fix prompt fired once, but NO terminal message (behavior unchanged on recovery).
		expect(userTexts.some((t) => t.includes("isn't verified yet"))).toBe(true);
		expect(userTexts.some((t) => t.includes(TERMINAL_MARKER))).toBe(false);
	});

	it("appends an explicit contradiction when the last message claimed completion", async () => {
		const harness = await createHarness({ settings: { verification: { command: NODE_FAIL, maxAttempts: 1 } } });
		harnesses.push(harness);
		const file = join(harness.tempDir, "out.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("wrote it"),
			// Fix turn ends with a completion claim while the check is still red.
			fauxAssistantMessage("All done — the task is complete."),
			fauxAssistantMessage("ok, honest summary"),
		]);

		await harness.session.prompt("create out.txt");

		const userTexts = getUserTexts(harness);
		expect(userTexts.some((t) => t.includes(TERMINAL_MARKER))).toBe(true);
		// Because the prior assistant message used completion language, the terminal
		// message reinforces the contradiction.
		expect(userTexts.some((t) => t.includes(CONTRADICTION_MARKER))).toBe(true);
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
