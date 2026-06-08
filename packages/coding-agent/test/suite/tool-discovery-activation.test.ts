/**
 * Characterizes the discovery-activation wiring: a tool activated in the hidden
 * tool-discovery index (what `search_tool_bm25` does, and what deferred MCP
 * tools rely on) is reconciled onto the active surface after a tool runs, so it
 * becomes callable on the next turn.
 */
import type { AgentTool } from "@pit/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { getCurrentToolDiscoveryIndex } from "../../src/core/tool-discovery.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";

describe("tool discovery activation reconcile", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	const pingTool: AgentTool = {
		name: "ping",
		label: "Ping",
		description: "Returns pong",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }),
	};

	it("registers and activates a deferred (index-only) tool after the next tool run", async () => {
		const harness = await createHarness({ tools: [pingTool] });
		harnesses.push(harness);

		// Only `ping` is active to start with — a deferred tool is not yet known to
		// the registry.
		expect(harness.session.getActiveToolNames()).not.toContain("secret_tool");

		// Register a hidden tool into the session's index (as deferred MCP tools and
		// the seed do), then activate it (as search_tool_bm25 would).
		const index = getCurrentToolDiscoveryIndex();
		expect(index).toBeDefined();
		index!.register({
			name: "secret_tool",
			description: "A deferred tool that was off the active surface",
			definition: {
				name: "secret_tool",
				label: "Secret",
				description: "A deferred tool",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "secret-result" }], details: {} }),
			},
		});
		index!.activate("secret_tool");

		// Run a turn that executes some tool → tool_execution_end fires the reconcile.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ping", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		// The deferred tool is now on the active surface, callable next turn.
		expect(harness.session.getActiveToolNames()).toContain("secret_tool");
	});

	it("does not touch the active surface when the index has no activations", async () => {
		const harness = await createHarness({ tools: [pingTool] });
		harnesses.push(harness);

		const before = [...harness.session.getActiveToolNames()].sort();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ping", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		expect([...harness.session.getActiveToolNames()].sort()).toEqual(before);
	});

	it("discovers, activates, and runs a real built-in tool end-to-end via search_tool_bm25", async () => {
		// No `tools` override → the session uses its real default surface, so
		// search_tool_bm25 is active and _seedToolDiscovery populates the index
		// with the opt-in built-ins (calc among them).
		const harness = await createHarness();
		harnesses.push(harness);

		// calc starts hidden (in the index), not on the active surface.
		expect(harness.session.getActiveToolNames()).toContain("search_tool_bm25");
		expect(harness.session.getActiveToolNames()).not.toContain("calc");

		// Single run: the model searches+activates calc, then calls it on the very
		// next turn of the SAME run. This only closes because the loop re-reads the
		// active tool surface each turn (getActiveTools) after the reconcile.
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("search_tool_bm25", { query: "evaluate an arithmetic math expression", activate_top: true })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("calc", { expression: "111 * 111" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("do the math for 111 * 111");

		// Full loop in one run: search ranked + activated calc, the reconcile pulled
		// it onto the surface, the loop re-read it for the next turn, and calc ran.
		const transcript = harness.session.messages.map(getMessageText).join("\n");
		expect(transcript).toContain("Activated: calc");
		expect(harness.session.getActiveToolNames()).toContain("calc");
		expect(transcript).toContain("12321");
		expect(transcript).not.toContain('Tool "calc" not found');
	});
});
