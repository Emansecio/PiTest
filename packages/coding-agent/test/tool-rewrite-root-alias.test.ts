/**
 * Unit coverage for the cross-harness `root` -> `path` Tier-1 auto rewrites on
 * the navigation tools (grep, find). Other harnesses name the search directory
 * `root`; the Pit schema names it `path` and is additionalProperties:false, so
 * without the rename the call fails validation. The rewrite is scoped per-tool
 * and must never touch a call that already carries `path`, nor a non-string
 * `root`.
 */

import { fauxToolCall } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { createDefaultToolRewriteRegistry } from "../src/core/tool-rewrite-rules.js";

describe("root -> path alias rewrite", () => {
	const registry = createDefaultToolRewriteRegistry();

	it("renames grep({root}) to grep({path}) preserving other args", () => {
		const outcome = registry.apply(fauxToolCall("grep", { pattern: "x", root: "src" }));
		expect(outcome.kind).toBe("rewritten");
		if (outcome.kind !== "rewritten") return;
		expect(outcome.ruleIds).toContain("grep-root-to-path");
		expect(outcome.call.arguments).toEqual({ pattern: "x", path: "src" });
	});

	it("renames find({root}) to find({path})", () => {
		const outcome = registry.apply(fauxToolCall("find", { pattern: "*.ts", root: "packages" }));
		expect(outcome.kind).toBe("rewritten");
		if (outcome.kind !== "rewritten") return;
		expect(outcome.ruleIds).toContain("find-root-to-path");
		expect(outcome.call.arguments).toEqual({ pattern: "*.ts", path: "packages" });
	});

	it("does not fire when path is already present", () => {
		const outcome = registry.apply(fauxToolCall("grep", { pattern: "x", root: "src", path: "lib" }));
		expect(outcome.kind).toBe("pass");
	});

	it("does not fire when root is not a string", () => {
		const outcome = registry.apply(fauxToolCall("grep", { pattern: "x", root: 3 as unknown as string }));
		expect(outcome.kind).toBe("pass");
	});

	it("leaves a normal grep({path}) call untouched", () => {
		const outcome = registry.apply(fauxToolCall("grep", { pattern: "x", path: "src" }));
		expect(outcome.kind).toBe("pass");
	});
});

describe("todo batch-format absorption", () => {
	const registry = createDefaultToolRewriteRegistry();

	it("maps the TodoWrite todos[] shape onto action:set", () => {
		const outcome = registry.apply(
			fauxToolCall("todo", {
				todos: [
					{ content: "a", status: "completed" },
					{ content: "b", activeForm: "doing b", status: "in_progress" },
				],
			}),
		);
		expect(outcome.kind).toBe("rewritten");
		if (outcome.kind !== "rewritten") return;
		expect(outcome.ruleIds).toContain("todo-batch-to-set");
		expect(outcome.call.arguments).toEqual({
			action: "set",
			items: [
				{ subject: "a", status: "completed" },
				{ subject: "b", activeForm: "doing b", status: "in_progress" },
			],
		});
	});

	it("supplies the missing action for a bare items[] batch", () => {
		const outcome = registry.apply(fauxToolCall("todo", { items: [{ subject: "a", id: 3 }] }));
		expect(outcome.kind).toBe("rewritten");
		if (outcome.kind !== "rewritten") return;
		expect(outcome.call.arguments).toEqual({ action: "set", items: [{ subject: "a", id: 3 }] });
	});

	it("leaves an already-correct set call untouched", () => {
		const outcome = registry.apply(fauxToolCall("todo", { action: "set", items: [{ subject: "a" }] }));
		expect(outcome.kind).toBe("pass");
	});

	it("does not reshape a batch whose entries have no usable title", () => {
		const outcome = registry.apply(fauxToolCall("todo", { items: [{ subject: "a" }, { note: "b" }] }));
		expect(outcome.kind).toBe("pass");
	});

	it("lets a valid single-action todo call pass", () => {
		const outcome = registry.apply(fauxToolCall("todo", { action: "create", subject: "x", activeForm: "doing x" }));
		expect(outcome.kind).toBe("pass");
	});

	it("does not fire when todos is not an array", () => {
		const outcome = registry.apply(fauxToolCall("todo", { action: "list", todos: "nope" as unknown as [] }));
		expect(outcome.kind).toBe("pass");
	});
});
