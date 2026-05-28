import { describe, expect, it } from "vitest";
import { ToolRewriteRegistry } from "../src/tool-rewrite-registry.js";
import type { AgentToolCall } from "../src/types.js";

function call(name: string, args: Record<string, unknown>): AgentToolCall {
	return { type: "toolCall", id: "call-1", name, arguments: args };
}

describe("ToolRewriteRegistry", () => {
	it("passes through when no rule matches", () => {
		const reg = new ToolRewriteRegistry();
		reg.add({
			id: "noop",
			appliesTo: "read",
			matcher: () => false,
			action: { tier: "auto", rewrite: (c) => c },
		});
		const outcome = reg.apply(call("read", { path: "x" }));
		expect(outcome.kind).toBe("pass");
	});

	it("auto rule rewrites args and reports the rule id", () => {
		const reg = new ToolRewriteRegistry();
		reg.add({
			id: "file_path-to-path",
			appliesTo: "read",
			matcher: (c) => "file_path" in c.arguments && !("path" in c.arguments),
			action: {
				tier: "auto",
				rewrite: (c) => {
					const { file_path, ...rest } = c.arguments as Record<string, unknown>;
					return { ...c, arguments: { ...rest, path: file_path } };
				},
			},
		});
		const outcome = reg.apply(call("read", { file_path: "x.ts" }));
		expect(outcome.kind).toBe("rewritten");
		if (outcome.kind === "rewritten") {
			expect(outcome.call.arguments).toEqual({ path: "x.ts" });
			expect(outcome.ruleIds).toEqual(["file_path-to-path"]);
		}
	});

	it("chains multiple auto rules in a single apply pass", () => {
		const reg = new ToolRewriteRegistry();
		reg.add({
			id: "rename-a-to-b",
			appliesTo: "*",
			matcher: (c) => "a" in c.arguments,
			action: {
				tier: "auto",
				rewrite: (c) => {
					const { a, ...rest } = c.arguments as Record<string, unknown>;
					return { ...c, arguments: { ...rest, b: a } };
				},
			},
		});
		reg.add({
			id: "rename-b-to-c",
			appliesTo: "*",
			matcher: (c) => "b" in c.arguments,
			action: {
				tier: "auto",
				rewrite: (c) => {
					const { b, ...rest } = c.arguments as Record<string, unknown>;
					return { ...c, arguments: { ...rest, c: b } };
				},
			},
		});
		const outcome = reg.apply(call("any", { a: 1 }));
		expect(outcome.kind).toBe("rewritten");
		if (outcome.kind === "rewritten") {
			expect(outcome.call.arguments).toEqual({ c: 1 });
			expect(outcome.ruleIds).toEqual(["rename-a-to-b", "rename-b-to-c"]);
		}
	});

	it("never fires the same auto rule twice in a chain", () => {
		// Rule deliberately re-matches its own output to prove the dedup guard.
		const reg = new ToolRewriteRegistry();
		let calls = 0;
		reg.add({
			id: "always",
			appliesTo: "*",
			matcher: () => true,
			action: {
				tier: "auto",
				rewrite: (c) => {
					calls++;
					return c;
				},
			},
		});
		const outcome = reg.apply(call("any", {}));
		expect(calls).toBe(1);
		expect(outcome.kind).toBe("rewritten");
	});

	it("suggest rule rejects with the formatted message", () => {
		const reg = new ToolRewriteRegistry();
		reg.add({
			id: "bash-cat-to-read",
			appliesTo: "bash",
			matcher: (c) => typeof (c.arguments as { command?: unknown }).command === "string",
			action: { tier: "suggest", message: () => "Use `read({path:'X'})` instead of `bash('cat X')`." },
		});
		const outcome = reg.apply(call("bash", { command: "cat foo.ts" }));
		expect(outcome.kind).toBe("rejected");
		if (outcome.kind === "rejected") {
			expect(outcome.error).toContain("Use `read");
			expect(outcome.ruleId).toBe("bash-cat-to-read");
		}
	});

	it("block rule rejects with the formatted reason", () => {
		const reg = new ToolRewriteRegistry();
		reg.add({
			id: "edit-noop",
			appliesTo: "edit",
			matcher: (c) => {
				const args = c.arguments as { oldText?: string; newText?: string };
				return args.oldText === args.newText;
			},
			action: { tier: "block", reason: () => "No-op: oldText === newText" },
		});
		const outcome = reg.apply(call("edit", { oldText: "foo", newText: "foo" }));
		expect(outcome.kind).toBe("rejected");
		if (outcome.kind === "rejected") {
			expect(outcome.error).toBe("No-op: oldText === newText");
		}
	});

	it("only applies rules whose appliesTo matches the tool name", () => {
		const reg = new ToolRewriteRegistry();
		reg.add({
			id: "for-read-only",
			appliesTo: "read",
			matcher: () => true,
			action: { tier: "block", reason: () => "blocked" },
		});
		expect(reg.apply(call("read", {})).kind).toBe("rejected");
		expect(reg.apply(call("bash", {})).kind).toBe("pass");
	});

	it("accepts an array of tool names in appliesTo", () => {
		const reg = new ToolRewriteRegistry();
		reg.add({
			id: "for-read-or-grep",
			appliesTo: ["read", "grep"],
			matcher: () => true,
			action: { tier: "block", reason: () => "blocked" },
		});
		expect(reg.apply(call("read", {})).kind).toBe("rejected");
		expect(reg.apply(call("grep", {})).kind).toBe("rejected");
		expect(reg.apply(call("ls", {})).kind).toBe("pass");
	});

	it("auto chain is short-circuited by the first matching suggest rule", () => {
		const reg = new ToolRewriteRegistry();
		let autoCalled = false;
		reg.add({
			id: "auto-first",
			appliesTo: "*",
			matcher: (c) => "a" in c.arguments,
			action: {
				tier: "auto",
				rewrite: (c) => {
					autoCalled = true;
					return { ...c, arguments: { ...c.arguments, b: 1 } };
				},
			},
		});
		reg.add({
			id: "suggest-second",
			appliesTo: "*",
			matcher: (c) => "b" in c.arguments,
			action: { tier: "suggest", message: () => "use Y" },
		});
		const outcome = reg.apply(call("any", { a: 1 }));
		expect(autoCalled).toBe(true);
		expect(outcome.kind).toBe("rejected");
		if (outcome.kind === "rejected") {
			expect(outcome.ruleId).toBe("suggest-second");
		}
	});
});
