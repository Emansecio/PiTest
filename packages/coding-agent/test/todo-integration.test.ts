/**
 * Integration test: the native `todo` tool mutates the session's TodoManager,
 * the state is persisted to the session file (survives /reload), and the
 * overlay getter reflects it.
 */
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.js";

describe("todo tool integration", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("is active by default, mutates state, persists, and feeds the overlay", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		expect(harness.session.getActiveToolNames()).toContain("todo");

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("todo", { action: "create", subject: "Build it" }),
					fauxToolCall("todo", { action: "create", subject: "Test it" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxToolCall("todo", { action: "update", id: 1, status: "in_progress", activeForm: "Building" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("plan the work");

		const overlay = harness.session.todoForOverlay();
		expect(overlay.items.map((t) => t.subject)).toEqual(["Build it", "Test it"]);
		expect(overlay.items[0]?.status).toBe("in_progress");
		expect(harness.session.todoHasInProgress()).toBe(true);

		// Persisted to the session file (so it survives /reload).
		const todoEntries = harness.sessionManager
			.getEntries()
			.filter((e) => (e as { customType?: string }).customType === "todo");
		expect(todoEntries.length).toBeGreaterThan(0);
		const last = todoEntries[todoEntries.length - 1] as { data?: { items?: Array<{ subject: string }> } };
		expect(last.data?.items?.length).toBe(2);
	});
});
