/**
 * Tests for the plan-mode system-prompt section and its injection via the
 * permissions extension's `before_agent_start` handler.
 */

import { describe, expect, it } from "vitest";
import { createPermissionsExtension } from "../src/core/built-ins/permissions-extension.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { PermissionChecker } from "../src/core/permissions/checker.ts";
import { buildPlanModeSection } from "../src/core/permissions/plan-mode-prompt.ts";

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
