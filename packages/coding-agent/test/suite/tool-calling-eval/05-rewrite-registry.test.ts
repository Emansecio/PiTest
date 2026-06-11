/**
 * End-to-end coverage for the default tool-rewrite registry — verifies that
 * Tier 1 auto rewrites, Tier 2 cross-tool suggestions, and Tier 3 pre-flight
 * blocks all fire through the live agent loop. The faux provider emits the
 * exact broken shapes the registry was built for; the harness must surface
 * the rule's correction without ever executing the wrong call.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultToolRewriteRegistry } from "../../../src/core/tool-rewrite-rules.js";
import { createBashTool, createEditTool, createReadTool } from "../../../src/core/tools/index.js";
import { createHarness, type Harness } from "../harness.js";

describe("tool-rewrite-registry (e2e)", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	async function makeHarness() {
		const harness = await createHarness({
			tools: [createReadTool(process.cwd()), createEditTool(process.cwd()), createBashTool(process.cwd())],
			// Tier 2 is opt-in (off by default) because replay benchmarks show
			// it net-negative on real workloads. We exercise it here explicitly
			// to keep the rule mechanics tested for opt-in deployments.
			toolRewriteRegistry: createDefaultToolRewriteRegistry({ enableTier2: true }),
		});
		harnesses.push(harness);
		return harness;
	}

	function getLastToolError(harness: Harness): string {
		const events = harness.eventsOfType("tool_execution_end").filter((e) => e.isError);
		if (events.length === 0) return "";
		const last = events[events.length - 1];
		type TextPart = { type: "text"; text: string };
		return last.result.content
			.filter((c: { type: string; text?: string }): c is TextPart => c.type === "text")
			.map((c: TextPart) => c.text)
			.join("\n");
	}

	// ---------------- Tier 1 (auto rewrites) ----------------

	it("rewrites read({start_line, end_line}) into offset/limit silently", async () => {
		const harness = await makeHarness();
		const file = join(harness.tempDir, "src.ts");
		writeFileSync(file, "a\nb\nc\nd\ne\n");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: file, start_line: 2, end_line: 4 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read");
		const endEvent = harness.eventsOfType("tool_execution_end").find((e) => e.toolName === "read");
		expect(endEvent?.isError).toBe(false);
		// The result body comes from a normal read; we expect to see the three lines.
		type TextPart = { type: "text"; text: string };
		const text = endEvent?.result.content
			.filter((c: { type: string; text?: string }): c is TextPart => c.type === "text")
			.map((c: TextPart) => c.text)
			.join("\n");
		expect(text).toContain("b");
		expect(text).toContain("c");
		expect(text).toContain("d");
	});

	it("rewrites read({path: 'foo:10-12'}) by peeling the range suffix into offset/limit", async () => {
		const harness = await makeHarness();
		const file = join(harness.tempDir, "src.ts");
		const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
		writeFileSync(file, `${lines}\n`);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: `${file}:10-12` })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read");
		const endEvent = harness.eventsOfType("tool_execution_end").find((e) => e.toolName === "read");
		expect(endEvent?.isError).toBe(false);
		type TextPart = { type: "text"; text: string };
		const text = endEvent?.result.content
			.filter((c: { type: string; text?: string }): c is TextPart => c.type === "text")
			.map((c: TextPart) => c.text)
			.join("\n");
		expect(text).toContain("line10");
		expect(text).toContain("line11");
		expect(text).toContain("line12");
		expect(text).not.toContain("line13");
	});

	it("emits a tool_call_rewritten event when Tier 1 rules fire", async () => {
		const harness = await makeHarness();
		const file = join(harness.tempDir, "src.ts");
		writeFileSync(file, "x\n");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: file, start_line: 1, end_line: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read");
		const rewrites = harness.events.filter((e) => e.type === "tool_call_rewritten");
		expect(rewrites.length).toBe(1);
		expect((rewrites[0] as { ruleIds: string[] }).ruleIds).toContain("read-start-end-line-to-offset-limit");
	});

	it("auto-normalizes a Windows bash command (drive backslashes) before running", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo C:\\Users\\x" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("echo");
		const rewrites = harness.events.filter((e) => e.type === "tool_call_rewritten");
		expect(rewrites.length).toBe(1);
		expect((rewrites[0] as { ruleIds: string[] }).ruleIds).toContain("bash-windows-shell-normalize");
		// The rewritten command ran — no Tier 2/3 rejection intercepted it.
		const rejections = harness.events.filter((e) => e.type === "tool_call_rejected");
		expect(rejections.length).toBe(0);
	});

	// ---------------- Tier 2 (bash → dedicated tool suggestions) ----------------

	it("rejects bash('cat foo') with a copy-pasteable read suggestion", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "cat foo.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("inspect");
		const error = getLastToolError(harness);
		expect(error).toContain("Refused");
		expect(error).toContain("read");
		expect(error).toContain('"path":"foo.ts"');
	});

	it("rejects bash('grep -r pattern src/') with grep suggestion", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "grep -r foo src/" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("search");
		const error = getLastToolError(harness);
		expect(error).toContain("dedicated `grep` tool");
	});

	it("rejects bash('find . -name *.ts') with find suggestion", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "find . -name '*.ts'" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("find");
		const error = getLastToolError(harness);
		expect(error).toContain("dedicated `find` tool");
	});

	it("rejects bash('sed -n 10,20p foo') with read({offset,limit}) suggestion", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sed -n '10,20p' foo.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("slice");
		const error = getLastToolError(harness);
		expect(error).toContain("read");
		expect(error).toContain('"offset":10');
		expect(error).toContain('"limit":11');
	});

	it("does NOT intercept bash with shell metacharacters (pipes, redirects)", async () => {
		const harness = await makeHarness();
		// Pipe should disable Tier 2 substitution — let bash run normally.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "cat foo.ts | grep bar" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("pipe");
		// Bash will fail because foo.ts doesn't exist, but the failure is from
		// bash itself, not from a Tier 2 rejection. Confirm no rejection event.
		const rejections = harness.events.filter((e) => e.type === "tool_call_rejected");
		expect(rejections.length).toBe(0);
	});

	// ---------------- Tier 3 (pre-flight blocks) ----------------

	it("blocks edit with oldText === newText as no-op", async () => {
		const harness = await makeHarness();
		const file = join(harness.tempDir, "src.ts");
		writeFileSync(file, "foo\n");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", { path: file, edits: [{ oldText: "foo", newText: "foo" }] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("edit");
		const error = getLastToolError(harness);
		expect(error).toContain("No-op edit refused");
		expect(error).toContain("edits[0]");
	});

	it("blocks read({offset: 0}) as 1-indexed violation", async () => {
		const harness = await makeHarness();
		const file = join(harness.tempDir, "src.ts");
		writeFileSync(file, "x\n");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: file, offset: 0 })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read");
		const error = getLastToolError(harness);
		expect(error).toContain("1-indexed");
		expect(error).toContain("offset: 1");
	});

	it("blocks read({offset: -5}) as negative bounds", async () => {
		const harness = await makeHarness();
		const file = join(harness.tempDir, "src.ts");
		writeFileSync(file, "x\n");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: file, offset: -5 })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read");
		const error = getLastToolError(harness);
		expect(error).toContain("must be >= 1");
	});

	it("blocks bash('rm -rf /') as unsafe", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf /" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("danger");
		const error = getLastToolError(harness);
		expect(error).toContain("Refused unsafe");
	});

	it("emits tool_call_rejected with the rule id on block/suggest decisions", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "cat foo.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("cat");
		const rejections = harness.events.filter((e) => e.type === "tool_call_rejected");
		expect(rejections.length).toBe(1);
		expect((rejections[0] as { ruleId: string }).ruleId).toBe("bash-cat-to-read");
	});
});
