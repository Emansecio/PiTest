/**
 * Unit tests for the subagent recursion depth guard.
 *
 * These exercise the pure helpers that bound nesting — `resolveMaxSubagentDepth`
 * (env parsing) and `buildSubagentToolCatalog` (catalog rewriting) — without
 * spinning up a real Agent. The guard's contract: a subagent never inherits the
 * parent's coordinator tools, and only receives depth-incremented copies while it
 * is still within the nesting budget.
 */

import type { AgentTool } from "@pit/agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	buildSubagentToolCatalog,
	COORDINATOR_TOOL_BRAND,
	COORDINATOR_TOOL_NAMES,
	resolveMaxSubagentDepth,
} from "../src/core/built-ins/coordinator-extension.js";

function tool(name: string, depth?: number, coordinator = false): AgentTool {
	const t: AgentTool = {
		name,
		label: name,
		description: "",
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: depth === undefined ? {} : { depth } }),
	};
	if (coordinator) (t as { [COORDINATOR_TOOL_BRAND]?: boolean })[COORDINATOR_TOOL_BRAND] = true;
	return t;
}

describe("COORDINATOR_TOOL_NAMES", () => {
	it("includes task, parallel, and fanout", () => {
		expect(COORDINATOR_TOOL_NAMES.has("task")).toBe(true);
		expect(COORDINATOR_TOOL_NAMES.has("parallel")).toBe(true);
		expect(COORDINATOR_TOOL_NAMES.has("fanout")).toBe(true);
	});
});

describe("resolveMaxSubagentDepth", () => {
	it("defaults to 1 when unset or blank", () => {
		expect(resolveMaxSubagentDepth({})).toBe(1);
		expect(resolveMaxSubagentDepth({ PIT_SUBAGENT_MAX_DEPTH: "" })).toBe(1);
		expect(resolveMaxSubagentDepth({ PIT_SUBAGENT_MAX_DEPTH: "   " })).toBe(1);
	});

	it("honors a valid numeric override", () => {
		expect(resolveMaxSubagentDepth({ PIT_SUBAGENT_MAX_DEPTH: "3" })).toBe(3);
		expect(resolveMaxSubagentDepth({ PIT_SUBAGENT_MAX_DEPTH: "0" })).toBe(0);
	});

	it("falls back on non-numeric or negative values", () => {
		expect(resolveMaxSubagentDepth({ PIT_SUBAGENT_MAX_DEPTH: "abc" })).toBe(1);
		expect(resolveMaxSubagentDepth({ PIT_SUBAGENT_MAX_DEPTH: "-2" })).toBe(1);
	});
});

describe("buildSubagentToolCatalog (recursion depth guard)", () => {
	const parent: AgentTool[] = [
		tool("read"),
		tool("bash"),
		tool("task", undefined, true),
		tool("parallel", undefined, true),
		tool("fanout", undefined, true),
	];
	const make = (d: number) => [tool("task", d, true), tool("parallel", d, true), tool("fanout", d, true)];

	it("always strips all parent coordinator tools", () => {
		const catalog = buildSubagentToolCatalog(parent, 5, 5, make);
		expect(catalog.map((t) => t.name)).toEqual(["read", "bash"]);
	});

	it("re-adds depth-incremented coordinator tools while within budget", () => {
		const catalog = buildSubagentToolCatalog(parent, 1, 2, make);
		expect(catalog.map((t) => t.name)).toEqual(["read", "bash", "task", "parallel", "fanout"]);
	});

	it("the re-added tools carry the child depth (not the parent's)", async () => {
		const catalog = buildSubagentToolCatalog(parent, 1, 5, make);
		for (const name of ["task", "parallel", "fanout"]) {
			const coordTool = catalog.find((t) => t.name === name);
			const result = await coordTool?.execute("id", {}, undefined);
			expect((result?.details as { depth: number }).depth).toBe(1);
		}
	});

	it("withholds all coordinator tools at the nesting limit (default budget = 1)", () => {
		const catalog = buildSubagentToolCatalog(parent, 1, 1, make);
		for (const name of COORDINATOR_TOOL_NAMES) {
			expect(catalog.some((t) => t.name === name)).toBe(false);
		}
	});
});
