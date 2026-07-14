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
