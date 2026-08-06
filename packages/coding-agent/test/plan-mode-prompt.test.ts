/**
 * Tests for the plan-mode system-prompt section and its placement in the
 * system prompt's cacheable prefix.
 */

import { splitSystemPromptOnDynamic } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { createPermissionsExtension } from "../src/core/built-ins/permissions-extension.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { BUILTIN_TOOL_SIDE_EFFECTS, PermissionChecker } from "../src/core/permissions/checker.ts";
import { buildPermissionModeSection } from "../src/core/permissions/mode-prompt.ts";
import { buildPlanModeSection, planBlockedToolNames } from "../src/core/permissions/plan-mode-prompt.ts";
import { EXTENSION_TOOL_SIDE_EFFECTS, isPlanBlockingSideEffect } from "../src/core/permissions/side-effect.ts";
import type { PermissionMode } from "../src/core/permissions/types.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

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

	it("merges the extension side-effect map explicitly (memory_append survives a map split)", () => {
		// The derivation must not depend on BUILTIN_TOOL_SIDE_EFFECTS re-exporting
		// the extension entries — every plan-blocking EXTENSION tool is derived too.
		const derived = new Set(planBlockedToolNames());
		for (const [name, effect] of Object.entries(EXTENSION_TOOL_SIDE_EFFECTS)) {
			if (!isPlanBlockingSideEffect(effect)) continue;
			expect(derived.has(name), `expected "${name}" in the derived list`).toBe(true);
		}
		expect(derived.has("memory_append")).toBe(true);
	});
});

describe("blocked-tool list narrowed to the session surface", () => {
	it("drops tools the session never registered (no noise about ast_edit & co.)", () => {
		const surface = ["read", "grep", "bash", "edit", "write", "task", "memory_append"];
		const derived = planBlockedToolNames(surface);
		expect(derived).toEqual(["bash", "edit", "memory_append", "task", "write"]);
		for (const absent of ["ast_edit", "edit_v2", "preview", "recipe", "resolve", "undo", "goal_complete"]) {
			expect(derived).not.toContain(absent);
		}
	});

	it("is a subset of the full static derivation (never invents a tool)", () => {
		const all = new Set(planBlockedToolNames());
		for (const name of planBlockedToolNames(["bash", "edit", "read", "not_a_tool"])) {
			expect(all.has(name), `"${name}" is not in the canonical derivation`).toBe(true);
		}
	});

	it("renders the narrowed list into <plan_mode> and <ask_mode> alike", () => {
		const surface = ["read", "grep", "bash", "edit"];
		for (const section of [
			buildPermissionModeSection("plan", surface)!,
			buildPermissionModeSection("ask", surface)!,
		]) {
			expect(section).toContain("bash, edit, and MCP tools");
			expect(section).not.toContain("ast_edit");
			expect(section).not.toContain("recipe");
		}
	});

	it("degrades to a sentence when the surface has no mutating tool at all", () => {
		const section = buildPermissionModeSection("plan", ["read", "grep"])!;
		expect(planBlockedToolNames(["read", "grep"])).toEqual([]);
		expect(section).toContain("MCP tools, and anything that writes, executes or spawns");
		expect(section).not.toContain("()");
	});

	it("keeps the full static list when no surface is passed (compat)", () => {
		expect(buildPermissionModeSection("plan")).toContain("ast_edit");
		expect(buildPermissionModeSection("ask")).toContain("ast_edit");
	});

	it("makes the no-subagent-carve-out decision explicit", () => {
		const s = buildPlanModeSection();
		expect(s.toLowerCase()).toContain("subagent");
		expect(s).toContain("carve-out");
	});
});

describe("permission-mode section — cacheable-prefix placement", () => {
	it("resolves the plan section from the mode, and nothing for auto", () => {
		expect(buildPermissionModeSection("plan")).toContain("<plan_mode>");
		expect(buildPermissionModeSection("ask")).toContain("<ask_mode>");
		expect(buildPermissionModeSection("confirm")).toContain("<confirm_mode>");
		expect(buildPermissionModeSection("auto")).toBeUndefined();
	});

	it("renders BEFORE the dynamic marker (the section is cached, not re-billed per request)", () => {
		const prompt = buildSystemPrompt({
			cwd: process.cwd(),
			selectedTools: ["read"],
			contextFiles: [],
			skills: [],
			permissionModeSection: buildPermissionModeSection("plan"),
		});
		const { staticPart, dynamicPart } = splitSystemPromptOnDynamic(prompt);
		expect(staticPart).toContain("<plan_mode>");
		expect(dynamicPart).not.toContain("<plan_mode>");
	});

	it("changes the cached prefix when the mode changes, and only then", () => {
		const base = { cwd: process.cwd(), selectedTools: ["read"], contextFiles: [], skills: [] };
		const prefixFor = (mode: PermissionMode) =>
			splitSystemPromptOnDynamic(
				buildSystemPrompt({ ...base, permissionModeSection: buildPermissionModeSection(mode) }),
			).staticPart;
		expect(prefixFor("plan")).toBe(prefixFor("plan"));
		expect(prefixFor("plan")).not.toBe(prefixFor("ask"));
		expect(prefixFor("auto")).not.toContain("_mode>");
	});

	it("stays byte-stable across rebuilds with the same mode AND the same tool surface", () => {
		// The narrowed list is derived from the SAME array that feeds selectedTools,
		// so it can only move on a rebuild whose tool block already moved.
		const prefixFor = (tools: string[]) =>
			splitSystemPromptOnDynamic(
				buildSystemPrompt({
					cwd: process.cwd(),
					selectedTools: tools,
					contextFiles: [],
					skills: [],
					permissionModeSection: buildPermissionModeSection("plan", tools),
				}),
			).staticPart;
		expect(prefixFor(["read", "bash", "edit"])).toBe(prefixFor(["read", "bash", "edit"]));
		expect(prefixFor(["read", "bash", "edit"])).not.toBe(prefixFor(["read", "bash"]));
	});

	it("the permissions extension no longer appends the section per-turn", () => {
		for (const mode of ["plan", "ask", "confirm", "auto"] as const) {
			const checker = new PermissionChecker({ cwd, mode, settings: {} });
			const { api, fire } = makeFakePi();
			createPermissionsExtension({ cwd, checker })(api);
			expect(fire("before_agent_start", { systemPrompt: "BASE" })).toBeUndefined();
		}
	});

	it("registers the exit_plan tool", () => {
		const checker = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		const { api, tools } = makeFakePi();
		createPermissionsExtension({ cwd, checker })(api);
		expect(tools.some((t: any) => t.name === "exit_plan")).toBe(true);
	});
});
