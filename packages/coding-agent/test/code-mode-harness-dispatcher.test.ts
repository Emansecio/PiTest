/**
 * Anti-bypass unit test for `buildHarnessDispatcher`.
 *
 * The whole point of code-mode is that a `tools.x()` call gets the SAME harness
 * treatment as a normal model tool call. This test drives the dispatcher
 * directly (no kernel) with fake harness primitives and asserts the pipeline
 * order and that each gate is actually consulted:
 *   - a rewrite-registry "rejected" outcome short-circuits before execute,
 *   - beforeToolCall `block` denies the call (permission gate honored),
 *   - on success the real tool.execute runs and afterToolCall can override,
 *   - on error the error-hint registry appends a hint.
 */

import type { AgentTool, AgentToolResult } from "@pit/agent-core";
import { describe, expect, it } from "vitest";
import { buildHarnessDispatcher, type HarnessDispatcherDeps } from "../src/core/code-mode/bridge.ts";

function fakeTool(name: string, impl: () => AgentToolResult<unknown>): AgentTool<any> {
	return {
		name,
		label: name,
		description: "",
		parameters: { type: "object" } as never,
		execute: async () => impl(),
	} as unknown as AgentTool<any>;
}

function baseDeps(tool: AgentTool<any>, over?: Partial<HarnessDispatcherDeps>): HarnessDispatcherDeps {
	return {
		getTool: (n) => (n === tool.name ? tool : undefined),
		getContext: () => ({}) as never,
		getAssistantMessage: () => ({}) as never,
		...over,
	};
}

const ok = (text: string): AgentToolResult<unknown> => ({
	content: [{ type: "text", text }],
	details: undefined,
});

describe("buildHarnessDispatcher (anti-bypass)", () => {
	it("rewrite registry 'rejected' short-circuits BEFORE execute", async () => {
		let executed = false;
		const tool = fakeTool("read", () => {
			executed = true;
			return ok("ran");
		});
		const dispatch = buildHarnessDispatcher(
			baseDeps(tool, {
				toolRewriteRegistry: {
					apply: () => ({ kind: "rejected", error: "blocked by rule", ruleId: "r1" }),
				} as never,
			}),
		);
		const r = await dispatch("read", { path: "/x" }, undefined);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("blocked by rule");
		expect(executed).toBe(false);
	});

	it("beforeToolCall block denies the call (permission gate consulted)", async () => {
		let executed = false;
		const tool = fakeTool("bash", () => {
			executed = true;
			return ok("ran");
		});
		let sawCtx = false;
		const dispatch = buildHarnessDispatcher(
			baseDeps(tool, {
				beforeToolCall: async (ctx) => {
					sawCtx = ctx.toolCall.name === "bash";
					return { block: true, reason: "permission denied" };
				},
			}),
		);
		const r = await dispatch("bash", { command: "rm -rf /" }, undefined);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("permission denied");
		expect(executed).toBe(false);
		expect(sawCtx).toBe(true);
	});

	it("on success runs the real tool and afterToolCall can override the result", async () => {
		const tool = fakeTool("grep", () => ok("raw-result"));
		const dispatch = buildHarnessDispatcher(
			baseDeps(tool, {
				afterToolCall: async () => ({ content: [{ type: "text", text: "overridden" }] }),
			}),
		);
		const r = await dispatch("grep", { pattern: "x" }, undefined);
		expect(r.isError).toBe(false);
		expect(r.content[0].text).toBe("overridden");
	});

	it("error result gets a learned-error hint appended", async () => {
		const tool = fakeTool("edit", () => {
			throw new Error("file not found");
		});
		const dispatch = buildHarnessDispatcher(
			baseDeps(tool, {
				toolErrorHintRegistry: {
					apply: () => ({ hints: [{ ruleId: "h1", hint: "did you mean write?" }] }),
				} as never,
			}),
		);
		const r = await dispatch("edit", { path: "/x" }, undefined);
		expect(r.isError).toBe(true);
		const joined = r.content.map((c) => c.text).join("\n");
		expect(joined).toContain("file not found");
		expect(joined).toContain("[hint] did you mean write?");
	});

	it("unknown tool name returns an error without throwing", async () => {
		const tool = fakeTool("read", () => ok("ran"));
		const dispatch = buildHarnessDispatcher(baseDeps(tool));
		const r = await dispatch("nope", {}, undefined);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("Unknown tool");
	});
});
