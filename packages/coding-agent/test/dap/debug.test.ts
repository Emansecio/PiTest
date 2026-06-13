import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { type DapResolvedAdapter, dapSessionManager } from "../../src/core/dap/index.ts";
import { createDebugToolDefinition } from "../../src/core/tools/debug.ts";

const FAKE = fileURLToPath(new URL("./fake-dap-adapter.mjs", import.meta.url));

function fakeAdapter(): DapResolvedAdapter {
	return {
		name: "fake",
		command: "node",
		args: [FAKE],
		resolvedCommand: process.execPath,
		languages: ["c"],
		fileTypes: [".c"],
		rootMarkers: [],
		launchDefaults: { stopOnEntry: true },
		attachDefaults: {},
		connectMode: "stdio",
	};
}

type ToolResult = { content: Array<{ type: string; text?: string }> };
function text(result: unknown): string {
	return (result as ToolResult).content[0]?.text ?? "";
}

describe("DapSessionManager — end-to-end against a fake adapter", () => {
	afterAll(async () => {
		await dapSessionManager.disposeAll();
	});

	it("launch → stopOnEntry → inspect → continue → terminate", async () => {
		const adapter = fakeAdapter();
		const summary = await dapSessionManager.launch(
			{ adapter, program: "/x/main.c", cwd: tmpdir() },
			undefined,
			10_000,
		);
		expect(summary.status).toBe("stopped");
		expect(summary.stopReason).toBe("entry");

		const bp = await dapSessionManager.setBreakpoint("/x/main.c", 42);
		expect(bp.breakpoints[0]?.verified).toBe(true);
		expect(bp.breakpoints[0]?.line).toBe(42);

		const threads = await dapSessionManager.threads();
		expect(threads.threads[0]?.name).toBe("main");

		const stack = await dapSessionManager.stackTrace(undefined);
		expect(stack.stackFrames[0]?.name).toBe("main");
		expect(stack.stackFrames[0]?.line).toBe(42);

		const scopes = await dapSessionManager.scopes(undefined);
		expect(scopes.scopes[0]?.name).toBe("Locals");

		const variables = await dapSessionManager.variables(100);
		expect(variables.variables[0]?.name).toBe("counter");
		expect(variables.variables[0]?.value).toBe("42");

		const evaluation = await dapSessionManager.evaluate("counter", "repl", undefined);
		expect(evaluation.evaluation.result).toContain("EVAL:counter");

		const cont = await dapSessionManager.continue(undefined, 10_000);
		expect(cont.state).toBe("stopped");

		const out = dapSessionManager.getOutput();
		expect(out.output).toContain("hello from program");

		const term = await dapSessionManager.terminate();
		expect(term?.status).toBe("terminated");
	}, 60_000);

	it("function breakpoints round-trip", async () => {
		const adapter = fakeAdapter();
		await dapSessionManager.launch({ adapter, program: "/x/main.c", cwd: tmpdir() }, undefined, 10_000);
		const fb = await dapSessionManager.setFunctionBreakpoint("main");
		expect(fb.breakpoints[0]?.name).toBe("main");
		expect(fb.breakpoints[0]?.verified).toBe(true);
		await dapSessionManager.terminate();
	}, 60_000);

	it("enforces a single active session", async () => {
		const adapter = fakeAdapter();
		await dapSessionManager.launch({ adapter, program: "/x/main.c", cwd: tmpdir() }, undefined, 10_000);
		await expect(
			dapSessionManager.launch({ adapter, program: "/x/other.c", cwd: tmpdir() }, undefined, 10_000),
		).rejects.toThrow(/still active/);
		await dapSessionManager.terminate();
	}, 60_000);
});

describe("debug tool — validation and no-session behavior", () => {
	const cwd = tmpdir();
	const def = createDebugToolDefinition(cwd);
	const ctx = {} as Parameters<typeof def.execute>[4];
	const run = (params: Record<string, unknown>) => def.execute("d", params as never, undefined, undefined, ctx);

	it("launch without program throws", async () => {
		await expect(run({ action: "launch" })).rejects.toThrow(/program is required/);
	});

	it("attach without pid or port throws", async () => {
		await expect(run({ action: "attach" })).rejects.toThrow(/requires pid or port/);
	});

	it("set_breakpoint without file+line or function throws", async () => {
		await expect(run({ action: "set_breakpoint" })).rejects.toThrow(/file\+line or function/);
	});

	it("variables without a reference throws", async () => {
		await expect(run({ action: "variables" })).rejects.toThrow(/variable_ref or scope_id/);
	});

	it("sessions lists nothing when idle", async () => {
		const out = text(await run({ action: "sessions" }));
		expect(out).toBe("No debug sessions.");
	});

	it("terminate with no session is a no-op message", async () => {
		const out = text(await run({ action: "terminate" }));
		expect(out).toContain("No debug session to terminate");
	});

	it("inspect actions without a session throw", async () => {
		await expect(run({ action: "threads" })).rejects.toThrow(/No active debug session/);
	});
});
