import { describe, expect, it } from "vitest";
import {
	appendHintsToContent,
	ToolErrorHintRegistry,
	type ToolErrorHintRule,
} from "../src/tool-error-hint-registry.js";
import type { AgentToolCall, AgentToolResult } from "../src/types.js";

function call(name: string, args: Record<string, unknown>): AgentToolCall {
	return { type: "toolCall", id: "tool-1", name, arguments: args };
}

function errorResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}

describe("ToolErrorHintRegistry", () => {
	it("returns no hints when no rule matches", () => {
		const reg = new ToolErrorHintRegistry();
		reg.add({
			id: "never",
			appliesTo: "*",
			matcher: () => false,
			hint: () => "should not fire",
		});
		const outcome = reg.apply(call("read", { path: "x" }), errorResult("ENOENT"));
		expect(outcome.hints).toEqual([]);
	});

	it("fires every matching rule and surfaces (ruleId, hint) pairs", () => {
		const reg = new ToolErrorHintRegistry();
		reg.add({
			id: "rule-a",
			appliesTo: "read",
			matcher: ({ errorText }) => errorText.includes("ENOENT"),
			hint: () => "Use find() to locate the file.",
		});
		reg.add({
			id: "rule-b",
			appliesTo: "read",
			matcher: ({ errorText }) => errorText.includes("ENOENT"),
			hint: () => "Confirm the cwd matches the path you expect.",
		});
		const outcome = reg.apply(call("read", { path: "x" }), errorResult("ENOENT: no such file"));
		expect(outcome.hints).toEqual([
			{ ruleId: "rule-a", hint: "Use find() to locate the file." },
			{ ruleId: "rule-b", hint: "Confirm the cwd matches the path you expect." },
		]);
	});

	it("dedupes hints with identical text across rules", () => {
		const reg = new ToolErrorHintRegistry();
		reg.add({
			id: "same-a",
			appliesTo: "*",
			matcher: () => true,
			hint: () => "Same hint text",
		});
		reg.add({
			id: "same-b",
			appliesTo: "*",
			matcher: () => true,
			hint: () => "Same hint text",
		});
		const outcome = reg.apply(call("read", { path: "x" }), errorResult("any"));
		expect(outcome.hints.length).toBe(1);
		expect(outcome.hints[0].ruleId).toBe("same-a");
	});

	it("skips silently when a matcher throws", () => {
		const reg = new ToolErrorHintRegistry();
		reg.add({
			id: "throws",
			appliesTo: "*",
			matcher: () => {
				throw new Error("boom");
			},
			hint: () => "never",
		});
		reg.add({
			id: "ok",
			appliesTo: "*",
			matcher: () => true,
			hint: () => "still fires",
		});
		const outcome = reg.apply(call("read", { path: "x" }), errorResult("e"));
		expect(outcome.hints.map((h) => h.ruleId)).toEqual(["ok"]);
	});

	it("respects appliesTo as string, array, and wildcard", () => {
		const reg = new ToolErrorHintRegistry();
		const rule = (id: string, applies: ToolErrorHintRule["appliesTo"]): ToolErrorHintRule => ({
			id,
			appliesTo: applies,
			matcher: () => true,
			hint: () => id,
		});
		reg.addMany([rule("only-read", "read"), rule("read-or-grep", ["read", "grep"]), rule("any", "*")]);
		expect(reg.apply(call("read", {}), errorResult("e")).hints.map((h) => h.ruleId)).toEqual([
			"only-read",
			"read-or-grep",
			"any",
		]);
		expect(reg.apply(call("grep", {}), errorResult("e")).hints.map((h) => h.ruleId)).toEqual(["read-or-grep", "any"]);
		expect(reg.apply(call("ls", {}), errorResult("e")).hints.map((h) => h.ruleId)).toEqual(["any"]);
	});
});

describe("appendHintsToContent", () => {
	it("appends a [hint] block to the trailing text block", () => {
		const content: AgentToolResult<unknown>["content"] = [{ type: "text", text: "ENOENT" }];
		const out = appendHintsToContent(content, [{ ruleId: "r", hint: "Try find()." }]);
		expect(out).toEqual([{ type: "text", text: "ENOENT\n\n[hint] Try find()." }]);
	});

	it("is idempotent — re-applying the same hint does not duplicate", () => {
		const initial = appendHintsToContent([{ type: "text", text: "ENOENT" }], [{ ruleId: "r", hint: "Try find()." }]);
		const reapplied = appendHintsToContent(initial, [{ ruleId: "r", hint: "Try find()." }]);
		expect(reapplied).toEqual(initial);
	});

	it("creates a fresh text block when no text block exists (image-only result)", () => {
		const out = appendHintsToContent([], [{ ruleId: "r", hint: "X" }]);
		expect(out).toEqual([{ type: "text", text: "[hint] X" }]);
	});

	it("preserves preceding non-text blocks", () => {
		const content: AgentToolResult<unknown>["content"] = [
			{ type: "image", data: "abc", mimeType: "image/png" },
			{ type: "text", text: "fail" },
		];
		const out = appendHintsToContent(content, [{ ruleId: "r", hint: "h1" }]);
		expect(out.length).toBe(2);
		expect(out[0]).toEqual({ type: "image", data: "abc", mimeType: "image/png" });
		expect(out[1]).toEqual({ type: "text", text: "fail\n\n[hint] h1" });
	});

	it("groups multiple hints into a single [hint] block per line", () => {
		const out = appendHintsToContent(
			[{ type: "text", text: "fail" }],
			[
				{ ruleId: "a", hint: "first" },
				{ ruleId: "b", hint: "second" },
			],
		);
		expect(out).toEqual([{ type: "text", text: "fail\n\n[hint] first\n[hint] second" }]);
	});
});
