/**
 * Tests for the plan-mode system-prompt section and its injection via the
 * permissions extension's `before_agent_start` handler.
 */

import { describe, expect, it } from "vitest";
import { createPermissionsExtension } from "../src/core/built-ins/permissions-extension.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { BUILTIN_TOOL_SIDE_EFFECTS, PermissionChecker } from "../src/core/permissions/checker.ts";
import { buildPlanModeSection, planBlockedToolNames } from "../src/core/permissions/plan-mode-prompt.ts";
import { isPlanBlockingSideEffect } from "../src/core/permissions/side-effect.ts";

const cwd = process.platform === "win32" ? "C:/proj" : "/proj";

type Handler = (event: any) => unknown;

function makeFakePi() {
	const handlers = new Map<string, Handler[]>();
	const tools: unknown[] = [];
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool: unknown) {
			tools.push(tool);
		},
		registerCommand() {},
		getOrchestration: () => "solo" as const,
		setOrchestration() {},
	} as unknown as ExtensionAPI;
	const fire = (event: string, payload: any): any => {
		let result: any;
		for (const handler of handlers.get(event) ?? []) {
			const r = handler(payload);
			if (r !== undefined && result === undefined) result = r;
		}
		return result;
	};
	return { api, fire, tools };
}

describe("buildPlanModeSection", () => {
	it("declares plan mode active and lists blocked tools", () => {
		const s = buildPlanModeSection();
		expect(s).toContain("<plan_mode>");
		expect(s).toContain("READ-ONLY");
		expect(s).toContain("edit");
		expect(s).toContain("bash");
	});

	it("imposes the workflow ending in exit_plan with brief and verify", () => {
		const s = buildPlanModeSection();
		expect(s).toContain("exit_plan");
		expect(s).toContain("brief");
		expect(s).toContain("verify");
	});

	it("derives the blocked list from the side-effect classification (no drift)", () => {
		const s = buildPlanModeSection();
		// Every tool the prompt derives as blocked must be named in the text.
		const derived = planBlockedToolNames();
		expect(derived.length).toBeGreaterThan(0);
		for (const name of derived) {
			expect(s, `expected the prompt to name blocked tool "${name}"`).toContain(name);
		}
		// The derivation itself must cover every plan-blocking built-in that is not
		// an optional integration namespace — this is the guard that fails when a
		// new mutating built-in is added but the prompt/derivation isn't updated.
		const expected = Object.entries(BUILTIN_TOOL_SIDE_EFFECTS)
			.filter(([name, effect]) => isPlanBlockingSideEffect(effect) && !/^(chrome_devtools_|security_)/.test(name))
			.map(([name]) => name)
			.sort();
		expect(derived).toEqual(expected);
	});

	it("names the spawn/memory tools that the old hardcoded list omitted", () => {
		const s = buildPlanModeSection();
		for (const name of ["task", "parallel", "fanout", "goal_complete", "memory_append"]) {
			expect(s, `expected the prompt to name "${name}"`).toContain(name);
		}
	});

	it("makes the no-subagent-carve-out decision explicit", () => {
		const s = buildPlanModeSection();
		expect(s.toLowerCase()).toContain("subagent");
		expect(s).toContain("carve-out");
	});
});

describe("permissions extension — before_agent_start injection", () => {
	it("appends the plan_mode section when the checker is in plan mode", () => {
		const checker = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		const { api, fire } = makeFakePi();
		createPermissionsExtension({ cwd, checker })(api);
		const res = fire("before_agent_start", { systemPrompt: "BASE" });
		expect(res).toBeDefined();
		expect(res.systemPrompt.startsWith("BASE")).toBe(true);
		expect(res.systemPrompt).toContain("<plan_mode>");
	});

	it("returns undefined in auto mode (no injection)", () => {
		const checker = new PermissionChecker({ cwd, mode: "auto", settings: {} });
		const { api, fire } = makeFakePi();
		createPermissionsExtension({ cwd, checker })(api);
		const res = fire("before_agent_start", { systemPrompt: "BASE" });
		expect(res).toBeUndefined();
	});

	it("registers the exit_plan tool", () => {
		const checker = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		const { api, tools } = makeFakePi();
		createPermissionsExtension({ cwd, checker })(api);
		expect(tools.some((t: any) => t.name === "exit_plan")).toBe(true);
	});
});
