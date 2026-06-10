/**
 * Learned-error store isolation.
 *
 * Two invariants that keep the cross-session store
 * (`~/.pit/agent/learned-errors/`) meaningful:
 *
 *  1. In-memory sessions (the entire test suite, ephemeral SDK embeds) must
 *     NOT persist learned errors on dispose. Before this guard, every vitest
 *     run wrote hundreds of synthetic fingerprints (faux tools, temp paths,
 *     "Blocked by test") into the developer's real store — 200/200 files in
 *     the observed store were test pollution.
 *
 *  2. Pre-flight registry rejections (Tier 2 suggest / Tier 3 block) must NOT
 *     be recorded as learned errors: their text is our own deliberate refusal
 *     message, not a model failure pattern worth a dynamic Tier 4 rule.
 */

import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultToolRewriteRegistry } from "../../../src/core/tool-rewrite-rules.js";
import { createReadTool } from "../../../src/core/tools/index.js";
import { createHarness, type Harness } from "../harness.js";

describe("learned-error store isolation (e2e)", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("does not record registry-rejected calls as learned errors", async () => {
		const harness = await createHarness({
			tools: [createReadTool(process.cwd())],
			toolRewriteRegistry: createDefaultToolRewriteRegistry(),
		});
		harnesses.push(harness);

		harness.setResponses([
			// Tier 3 block: read with offset 0 is rejected pre-flight.
			fauxAssistantMessage([fauxToolCall("read", { path: "/x", offset: 0 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read it");

		const rejected = harness.events.filter((e) => e.type === "tool_call_rejected");
		expect(rejected.length).toBe(1);

		// The session must not have learned the refusal text as an error pattern.
		const learned = (harness.session as unknown as { _learnedErrors: Map<string, unknown> })._learnedErrors;
		expect(learned.size).toBe(0);
	});

	it("still records genuine tool failures as learned errors", async () => {
		const harness = await createHarness({
			tools: [createReadTool(process.cwd())],
			toolRewriteRegistry: createDefaultToolRewriteRegistry(),
		});
		harnesses.push(harness);

		harness.setResponses([
			// Genuine failure: ENOENT on a nonexistent path passes the registry.
			fauxAssistantMessage([fauxToolCall("read", { path: "/definitely/not/a/real/path.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read it");

		const failed = harness.eventsOfType("tool_execution_end").find((e) => e.toolName === "read");
		expect(failed?.isError).toBe(true);

		const learned = (harness.session as unknown as { _learnedErrors: Map<string, unknown> })._learnedErrors;
		expect(learned.size).toBe(1);
	});
});
