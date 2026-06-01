/**
 * Unit tests for the subagent recursion depth guard.
 *
 * These exercise the pure helpers that bound nesting — `resolveMaxSubagentDepth`
 * (env parsing) and `buildSubagentToolCatalog` (catalog rewriting) — without
 * spinning up a real Agent. The guard's contract: a subagent never inherits the
 * parent's `task` tool, and only receives a depth-incremented copy while it is
 * still within the nesting budget.
 */

import type { AgentTool } from "@pit/agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	buildSubagentToolCatalog,
	COORDINATOR_TOOL_BRAND,
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
	// Coordinator tools are stripped by brand, not name — stamp it like the real factory does.
	if (coordinator) (t as { [COORDINATOR_TOOL_BRAND]?: boolean })[COORDINATOR_TOOL_BRAND] = true;
	return t;
}

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
	const parent: AgentTool[] = [tool("read"), tool("bash"), tool("task", undefined, true)];
	const make = (d: number) => tool("task", d, true);

	it("always strips the parent's coordinator tool", () => {
		// Budget exhausted: the child gets the parent's non-task tools only.
		const catalog = buildSubagentToolCatalog(parent, 5, 5, make);
		expect(catalog.map((t) => t.name)).toEqual(["read", "bash"]);
	});

	it("re-adds exactly one depth-incremented coordinator tool while within budget", () => {
		const catalog = buildSubagentToolCatalog(parent, 1, 2, make); // 1 < 2
		expect(catalog.filter((t) => t.name === "task")).toHaveLength(1);
		expect(catalog.map((t) => t.name)).toEqual(["read", "bash", "task"]);
	});

	it("the re-added tool carries the child depth (not the parent's)", async () => {
		const catalog = buildSubagentToolCatalog(parent, 1, 5, make);
		const taskTool = catalog.find((t) => t.name === "task");
		const result = await taskTool?.execute("id", {}, undefined);
		expect((result?.details as { depth: number }).depth).toBe(1);
	});

	it("withholds the coordinator tool at the nesting limit (default budget = 1)", () => {
		// A subagent at depth 1 (spawned by the parent at depth 0) cannot nest.
		const catalog = buildSubagentToolCatalog(parent, 1, 1, make); // 1 < 1 is false
		expect(catalog.some((t) => t.name === "task")).toBe(false);
	});
});
