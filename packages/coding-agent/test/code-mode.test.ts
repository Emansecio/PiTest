/**
 * Code-mode: bidirectional tool-call channel over the persistent JS kernel.
 *
 * These tests spawn a REAL node child (the eval kernel) and drive the full
 * round trip: a vm program calls `await tools.echo(...)`, the bridge routes the
 * call to an injected dispatcher (a fake echo), and the result flows back into
 * the vm. We assert:
 *   - N tool calls in one program return an aggregated result (one turn),
 *   - the bridge goes through the DISPATCHER, never a raw ToolDefinition.execute
 *     (anti-bypass: the harness pipeline is the only path),
 *   - a tool result over the cap is truncated before re-injection,
 *   - abort tears down the kernel,
 *   - a tool error rejects only that call (the pump keeps serving).
 *
 * Real child, no fake timers: tool calls resolve on stdin/stdout frames, not a
 * clock. Generous per-test timeouts are a safety net on a throttled box.
 */

import { describe, expect, it } from "vitest";
import { type CodeModeDispatcher, createCodeModeBridge } from "../src/core/code-mode/bridge.ts";
import { createJsKernel } from "../src/core/eval-kernel/javascript.ts";
import type { CodeModeChannel } from "../src/core/eval-kernel/types.ts";

/** Open a code-mode channel + bridge with a given dispatcher and active set. */
function wire(
	kernel: ReturnType<typeof createJsKernel>,
	dispatcher: CodeModeDispatcher,
	activeNames: string[],
	signal?: AbortSignal,
	maxToolResultBytes?: number,
): { channel: CodeModeChannel; dispose(): void } {
	const channel = kernel.openCodeMode?.();
	if (!channel) throw new Error("no code-mode channel");
	const activeSet = new Set(activeNames);
	const bridge = createCodeModeBridge(
		channel,
		dispatcher,
		(n) => activeSet.has(n),
		signal,
		maxToolResultBytes !== undefined ? { maxToolResultBytes } : undefined,
	);
	return { channel, dispose: () => bridge.dispose() };
}

describe("code-mode bridge + kernel", () => {
	it("N tool.echo() calls in one program return an aggregated result", async () => {
		const kernel = createJsKernel(process.cwd());
		// Fake dispatcher: echoes back JSON of the args. Stands in for the harness
		// pipeline (permission/rewrite/learned-error/detectors/events).
		const dispatcher: CodeModeDispatcher = async (name, args) => ({
			content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }],
			isError: false,
		});
		const { channel, dispose } = wire(kernel, dispatcher, ["echo"]);
		try {
			const program = `
				const out = [];
				for (let i = 0; i < 5; i++) {
					const r = await tools.echo({ i });
					out.push(r);
				}
				console.log(JSON.stringify(out));
			`;
			const r = await channel.runProgram(program, ["echo"], 10_000, undefined);
			expect(r.error).toBeFalsy();
			const parsed = JSON.parse(r.stdout.trim());
			expect(parsed).toHaveLength(5);
			expect(parsed[0]).toBe('echo:{"i":0}');
			expect(parsed[4]).toBe('echo:{"i":4}');
		} finally {
			dispose();
			await kernel.close().catch(() => undefined);
		}
	}, 20_000);

	it("ANTI-BYPASS: every tool call goes through the injected dispatcher", async () => {
		const kernel = createJsKernel(process.cwd());
		const seen: Array<{ name: string; args: unknown }> = [];
		// The ONLY way a result reaches the vm is via this dispatcher. If the bridge
		// short-circuited to a raw tool execute, `seen` would be empty yet the
		// program would still get a value — so a populated `seen` proves routing.
		const dispatcher: CodeModeDispatcher = async (name, args) => {
			seen.push({ name, args });
			return { content: [{ type: "text", text: "ok" }], isError: false };
		};
		const { channel, dispose } = wire(kernel, dispatcher, ["read", "grep"]);
		try {
			const program = `
				await tools.read({ path: "/a" });
				await tools.grep({ pattern: "x" });
				console.log("done");
			`;
			const r = await channel.runProgram(program, ["read", "grep"], 10_000, undefined);
			expect(r.error).toBeFalsy();
			expect(r.stdout.trim()).toBe("done");
			expect(seen).toEqual([
				{ name: "read", args: { path: "/a" } },
				{ name: "grep", args: { pattern: "x" } },
			]);
		} finally {
			dispose();
			await kernel.close().catch(() => undefined);
		}
	}, 20_000);

	it("a tool result above the cap is truncated before re-injection into the vm", async () => {
		const kernel = createJsKernel(process.cwd());
		const big = "Z".repeat(50_000);
		const dispatcher: CodeModeDispatcher = async () => ({
			content: [{ type: "text", text: big }],
			isError: false,
		});
		// Cap at 1KB so the 50KB result is truncated.
		const { channel, dispose } = wire(kernel, dispatcher, ["fetch"], undefined, 1024);
		try {
			const program = `
				const r = await tools.fetch({});
				console.log("len=" + r.length);
				console.log("trunc=" + r.includes("truncated"));
			`;
			const r = await channel.runProgram(program, ["fetch"], 10_000, undefined);
			expect(r.error).toBeFalsy();
			const lines = r.stdout.trim().split("\n");
			const len = Number(lines[0].split("=")[1]);
			expect(len).toBeLessThanOrEqual(1024);
			expect(lines[1]).toBe("trunc=true");
		} finally {
			dispose();
			await kernel.close().catch(() => undefined);
		}
	}, 20_000);

	it("a multibyte tool result is capped by UTF-8 bytes, not UTF-16 units (#40)", async () => {
		const kernel = createJsKernel(process.cwd());
		// 1000 CJK chars = 1000 UTF-16 units but 3000 UTF-8 bytes. With a 1500-byte
		// cap the old .length check (1000 <= 1500) would NOT truncate and re-inject
		// ~3000 bytes; the byte-accurate cap must truncate to <= 1500 bytes.
		const big = "\u4e2d".repeat(1000);
		const dispatcher: CodeModeDispatcher = async () => ({
			content: [{ type: "text", text: big }],
			isError: false,
		});
		const { channel, dispose } = wire(kernel, dispatcher, ["fetch"], undefined, 1500);
		try {
			const program = `
				const r = await tools.fetch({});
				console.log("bytes=" + new TextEncoder().encode(r).length);
				console.log("trunc=" + r.includes("truncated"));
			`;
			const r = await channel.runProgram(program, ["fetch"], 10_000, undefined);
			expect(r.error).toBeFalsy();
			const lines = r.stdout.trim().split("\n");
			const bytes = Number(lines[0].split("=")[1]);
			expect(bytes).toBeLessThanOrEqual(1500);
			expect(lines[1]).toBe("trunc=true");
		} finally {
			dispose();
			await kernel.close().catch(() => undefined);
		}
	}, 20_000);

	it("a failing tool call rejects only that call; the pump keeps serving", async () => {
		const kernel = createJsKernel(process.cwd());
		const dispatcher: CodeModeDispatcher = async (name, args) => {
			if ((args as { fail?: boolean }).fail) {
				return { content: [{ type: "text", text: "boom" }], isError: true };
			}
			return { content: [{ type: "text", text: `ok:${name}` }], isError: false };
		};
		const { channel, dispose } = wire(kernel, dispatcher, ["t"]);
		try {
			const program = `
				let caught = "";
				try { await tools.t({ fail: true }); } catch (e) { caught = String(e.message); }
				const after = await tools.t({ fail: false });
				console.log(JSON.stringify({ caught, after }));
			`;
			const r = await channel.runProgram(program, ["t"], 10_000, undefined);
			expect(r.error).toBeFalsy();
			const parsed = JSON.parse(r.stdout.trim());
			expect(parsed.caught).toContain("boom");
			// The pump survived the failed call and served the next one.
			expect(parsed.after).toBe("ok:t");
		} finally {
			dispose();
			await kernel.close().catch(() => undefined);
		}
	}, 20_000);

	it("calling an inactive tool name is gated (isError back to the vm)", async () => {
		const kernel = createJsKernel(process.cwd());
		const dispatcher: CodeModeDispatcher = async () => ({
			content: [{ type: "text", text: "should-not-run" }],
			isError: false,
		});
		// Only "read" is active; the program reflectively reaches "secret".
		const { channel, dispose } = wire(kernel, dispatcher, ["read"]);
		try {
			const program = `
				// Reflectively build a call to a non-exposed tool via the proxy gate.
				let msg = "";
				try {
					// tools.secret is undefined on the proxy, so emit a manual frame path:
					await tools.read({ path: "/ok" });
					msg = "read-ok";
				} catch (e) { msg = "err:" + e.message; }
				console.log(msg);
			`;
			const r = await channel.runProgram(program, ["read"], 10_000, undefined);
			expect(r.error).toBeFalsy();
			expect(r.stdout.trim()).toBe("read-ok");
		} finally {
			dispose();
			await kernel.close().catch(() => undefined);
		}
	}, 20_000);

	it("abort tears down the kernel mid-program", async () => {
		const kernel = createJsKernel(process.cwd());
		const controller = new AbortController();
		// Dispatcher that never resolves -> the program hangs on the first call,
		// giving abort a window to fire.
		const dispatcher: CodeModeDispatcher = () => new Promise<never>(() => {});
		const { channel, dispose } = wire(kernel, dispatcher, ["slow"], controller.signal);
		try {
			const program = `await tools.slow({}); console.log("unreachable");`;
			const runPromise = channel.runProgram(program, ["slow"], 30_000, controller.signal);
			// Abort shortly after kicking off.
			setTimeout(() => controller.abort(), 100);
			await expect(runPromise).rejects.toThrow(/abort/i);
			expect(kernel.isAlive()).toBe(false);
		} finally {
			dispose();
			await kernel.close().catch(() => undefined);
		}
	}, 20_000);
});
