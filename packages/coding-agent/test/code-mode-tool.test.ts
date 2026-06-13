/**
 * `code` tool (code-mode) — ToolDefinition-level test.
 *
 * Exercises the tool the model actually calls: build the definition with an
 * injected dispatcher + active-tool list (the agent-session wire), install a
 * real eval-kernel manager, and run a program that fans out tool calls. Also
 * asserts the unwired path (no dispatcher) reports cleanly instead of crashing.
 *
 * def.execute takes 5 args; the 5th is the ExtensionContext, unused here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodeModeDispatcher } from "../src/core/code-mode/bridge.ts";
import { createEvalKernelManager } from "../src/core/eval-kernel/index.ts";
import { setCurrentEvalKernelManager } from "../src/core/eval-kernel/types.ts";
import { createCodeModeToolDefinition } from "../src/core/tools/code-mode.ts";

type ExecCtx = Parameters<ReturnType<typeof createCodeModeToolDefinition>["execute"]>[4];

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => c.text ?? "").join("\n");
}

describe("code tool (code-mode)", () => {
	beforeEach(() => {
		setCurrentEvalKernelManager(createEvalKernelManager(process.cwd()));
	});

	afterEach(async () => {
		const m = createEvalKernelManager(process.cwd());
		await m.closeAll().catch(() => undefined);
		setCurrentEvalKernelManager(undefined);
	});

	it("runs a program that fans out tool calls through the injected dispatcher", async () => {
		const calls: string[] = [];
		const dispatcher: CodeModeDispatcher = async (name, args) => {
			calls.push(name);
			return { content: [{ type: "text", text: `${name}=${JSON.stringify(args)}` }], isError: false };
		};
		const def = createCodeModeToolDefinition(process.cwd(), {
			dispatcher,
			getActiveToolNames: () => ["read", "grep", "code"],
		});
		const ctx = {} as ExecCtx;
		const program = `
			const a = await tools.read({ path: "/x" });
			const b = await tools.grep({ pattern: "y" });
			console.log(a + " | " + b);
		`;
		const result = (await def.execute("id1", { code: program }, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
			isError?: boolean;
		};
		expect(result.isError).toBeFalsy();
		const text = textOf(result);
		expect(text).toContain('read={"path":"/x"}');
		expect(text).toContain('grep={"pattern":"y"}');
		expect(calls).toEqual(["read", "grep"]);
	}, 20_000);

	it("excludes `code` itself from the vm-exposed tools (no recursion)", async () => {
		const dispatcher: CodeModeDispatcher = async (name) => ({
			content: [{ type: "text", text: name }],
			isError: false,
		});
		const def = createCodeModeToolDefinition(process.cwd(), {
			dispatcher,
			getActiveToolNames: () => ["read", "code"],
		});
		const ctx = {} as ExecCtx;
		// tools.code is NOT on the proxy -> TypeError inside the vm, captured as error.
		const program = `console.log(typeof tools.code + "/" + typeof tools.read);`;
		const result = (await def.execute("id2", { code: program }, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
			isError?: boolean;
		};
		expect(textOf(result)).toContain("undefined/function");
	}, 20_000);

	it("reports cleanly when no dispatcher is wired (unwired session)", async () => {
		const def = createCodeModeToolDefinition(process.cwd(), {
			getActiveToolNames: () => ["read"],
		});
		const ctx = {} as ExecCtx;
		const result = (await def.execute("id3", { code: "console.log(1)" }, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
			isError?: boolean;
		};
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("not wired");
	}, 20_000);

	it("lists the available tools.* in the prompt guidelines", () => {
		const def = createCodeModeToolDefinition(process.cwd(), {
			dispatcher: async () => ({ content: [{ type: "text", text: "" }], isError: false }),
			getActiveToolNames: () => ["read", "grep", "code"],
		});
		const joined = (def.promptGuidelines ?? []).join("\n");
		expect(joined).toContain("tools.read");
		expect(joined).toContain("tools.grep");
		// `code` is filtered out of the exposed list.
		expect(joined).not.toContain("tools.code");
	});
});
