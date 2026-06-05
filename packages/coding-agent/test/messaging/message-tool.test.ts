import { afterEach, describe, expect, it } from "vitest";
import { agentMessageBus } from "../../src/core/messaging/index.ts";
import { createMessageToolDefinition } from "../../src/core/tools/message.ts";

type ToolResult = { content: Array<{ type: string; text?: string }>; details?: unknown };
function text(r: unknown): string {
	return (r as ToolResult).content[0]?.text ?? "";
}

describe("message tool", () => {
	const reserved: string[] = [];
	afterEach(() => {
		while (reserved.length) agentMessageBus.unregister(reserved.pop()!);
	});
	function reserve(id: string, reply?: (from: string, msg: string) => string) {
		const realId = agentMessageBus.reserve(id, { kind: id === "Main" ? "main" : "sub" });
		reserved.push(realId);
		if (reply) agentMessageBus.attachResponder(realId, async (from, msg) => reply(from, msg));
		return realId;
	}

	it("list reports online peers (excluding self)", async () => {
		reserve("Main", () => "x");
		const selfId = reserve("Worker");
		const def = createMessageToolDefinition(process.cwd(), { selfId });
		const out = text(await def.execute("c", { op: "list" } as never, undefined, undefined, {} as never));
		expect(out).toContain("Main");
		expect(out).not.toContain("Worker");
	});

	it("list with no peers says so", async () => {
		const selfId = reserve("Lonely");
		const def = createMessageToolDefinition(process.cwd(), { selfId });
		const out = text(await def.execute("c", { op: "list" } as never, undefined, undefined, {} as never));
		expect(out).toMatch(/no other agents/i);
	});

	it("send returns the recipient's reply", async () => {
		reserve("Main", (from, msg) => `Main got "${msg}" from ${from}`);
		const selfId = reserve("Worker");
		const def = createMessageToolDefinition(process.cwd(), { selfId });
		const r = await def.execute(
			"c",
			{ op: "send", to: "Main", message: "need a hand" } as never,
			undefined,
			undefined,
			{} as never,
		);
		expect(text(r)).toContain('Main got "need a hand" from Worker');
	});

	it("send without `to` throws", async () => {
		const selfId = reserve("Worker");
		const def = createMessageToolDefinition(process.cwd(), { selfId });
		await expect(
			def.execute("c", { op: "send", message: "hi" } as never, undefined, undefined, {} as never),
		).rejects.toThrow(/requires "to"/);
	});

	it("send without `message` throws", async () => {
		const selfId = reserve("Worker");
		const def = createMessageToolDefinition(process.cwd(), { selfId });
		await expect(
			def.execute("c", { op: "send", to: "Main" } as never, undefined, undefined, {} as never),
		).rejects.toThrow(/requires a non-empty "message"/);
	});

	it("send to an offline peer reports it as not found", async () => {
		const selfId = reserve("Worker");
		const def = createMessageToolDefinition(process.cwd(), { selfId });
		const out = text(
			await def.execute("c", { op: "send", to: "Ghost", message: "?" } as never, undefined, undefined, {} as never),
		);
		expect(out).toMatch(/not found|offline/i);
	});

	it("send honors a per-message timeout_ms override (hung peer fails fast)", async () => {
		const stuck = agentMessageBus.reserve("Slow", { kind: "sub" });
		reserved.push(stuck);
		agentMessageBus.attachResponder(
			stuck,
			(_from, _msg, signal) =>
				new Promise<string>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		const selfId = reserve("Worker");
		const def = createMessageToolDefinition(process.cwd(), { selfId });
		const out = text(
			await def.execute(
				"c",
				{ op: "send", to: "Slow", message: "expensive?", timeout_ms: 10 } as never,
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(out).toMatch(/failed/i);
	}, 5000);
});
