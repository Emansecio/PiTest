/**
 * Integration test: drives a real AgentSession (faux provider) through multi-turn
 * runs and asserts the todo-cadence wiring (ADR-0007) actually fires — i.e. the
 * reminder/nudge lands in the CONTEXT the model sees on the next turn, not just in
 * the pure decision fn (covered by todo-cadence.test.ts). Uses an inert `probe`
 * tool (always succeeds, never mutates, is not `todo`) so the turn sequence is
 * deterministic without touching the filesystem.
 */
import type { AgentTool } from "@pit/agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createTodoTool } from "../src/core/tools/todo.js";
import { createHarness, type Harness } from "./suite/harness.js";

const probe: AgentTool = createProbeTool();

function createProbeTool(): AgentTool {
	return {
		name: "probe",
		label: "probe",
		description: "Inert test probe — always succeeds, never mutates.",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	} as unknown as AgentTool;
}

function captureContext(sink: { text: string }) {
	return (context: Context) => {
		try {
			sink.text = JSON.stringify(context);
		} catch {
			sink.text = "";
		}
		return fauxAssistantMessage("done");
	};
}

describe("todo-cadence integration (real AgentSession wiring)", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	async function makeHarness(): Promise<Harness> {
		const harness = await createHarness({ tools: [createTodoTool(""), probe] });
		harnesses.push(harness);
		return harness;
	}

	it("fires the sync reminder after an item sits in_progress for K=3 untouched turns", async () => {
		const harness = await makeHarness();
		const sink = { text: "" };
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("todo", { action: "create", subject: "Build the thing" }),
					fauxToolCall("todo", { action: "update", id: 1, status: "in_progress", activeForm: "Building" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }), // stale 1
			fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }), // stale 2
			fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }), // stale 3 -> remind
			captureContext(sink),
		]);

		await harness.session.prompt("do the multi-step work");

		// The model's final-turn context carries the injected reminder, enumerated and
		// pointing at the open item by id.
		expect(sink.text).toContain("todo-sync-reminder");
		expect(sink.text).toContain("#1");
		expect(sink.text).toContain("in_progress");
	});

	it("fires the todo-first nudge after 2 work actions with no todo", async () => {
		const harness = await makeHarness();
		const sink = { text: "" };
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }), // work action 1
			fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }), // work action 2 -> nudge
			captureContext(sink),
		]);

		await harness.session.prompt("just start doing stuff");

		expect(sink.text).toContain("todo-first-reminder");
	});

	it("stays silent on the happy path (todo created, advanced, and completed)", async () => {
		const harness = await makeHarness();
		const sink = { text: "" };
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("todo", { action: "create", subject: "Build the thing" }),
					fauxToolCall("todo", { action: "update", id: 1, status: "in_progress", activeForm: "Building" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("todo", { action: "update", id: 1, status: "completed" })], {
				stopReason: "toolUse",
			}),
			captureContext(sink),
		]);

		await harness.session.prompt("do it cleanly");

		expect(sink.text).not.toContain("todo-sync-reminder");
		expect(sink.text).not.toContain("todo-first-reminder");
	});
});
