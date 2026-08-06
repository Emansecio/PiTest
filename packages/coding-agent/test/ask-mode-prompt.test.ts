/**
 * Tests for the ask-mode system-prompt section (rendered into the cacheable
 * prefix by the host — see plan-mode-prompt.test.ts for the placement invariant).
 *
 * Ask shares plan's enforcement, so what matters here is the DIFFERENCE: the
 * read-only warning survives, the plan ritual does not.
 */

import { describe, expect, it, vi } from "vitest";
import { createPermissionsExtension } from "../src/core/built-ins/permissions-extension.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { buildAskModeSection } from "../src/core/permissions/ask-mode-prompt.ts";
import { PermissionChecker } from "../src/core/permissions/checker.ts";
import { buildPermissionModeSection } from "../src/core/permissions/mode-prompt.ts";
import { planBlockedToolNames } from "../src/core/permissions/plan-mode-prompt.ts";

const cwd = process.platform === "win32" ? "C:/proj" : "/proj";

type Handler = (event: any) => unknown;

function makeFakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool() {},
		registerCommand(name: string, def: { handler: (args: string, ctx: any) => unknown }) {
			commands.set(name, def);
		},
		sendMessage() {},
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
	return { api, fire, commands };
}

describe("buildAskModeSection", () => {
	it("declares ask mode active and READ-ONLY", () => {
		const s = buildAskModeSection();
		expect(s).toContain("<ask_mode>");
		expect(s).toContain("</ask_mode>");
		expect(s).toContain("READ-ONLY");
	});

	it("derives the blocked list from the same canonical source as plan (no drift)", () => {
		const s = buildAskModeSection();
		const derived = planBlockedToolNames();
		expect(derived.length).toBeGreaterThan(0);
		for (const name of derived) {
			expect(s, `expected the prompt to name blocked tool "${name}"`).toContain(name);
		}
	});

	it("bans the plan ritual explicitly (no plan tool, no exit_plan, no proposal)", () => {
		const s = buildAskModeSection();
		expect(s).toContain("Do NOT run the plan ritual");
		expect(s).toContain("exit_plan");
		// The workflow words that define plan mode must NOT appear as instructions here.
		expect(s).not.toContain("Build the plan with the `plan` tool");
		expect(s).not.toContain("present it for user approval");
	});

	it("narrows the blocked list to the session's tool surface", () => {
		const surface = ["read", "grep", "bash", "write", "memory_append"];
		const s = buildAskModeSection(surface);
		expect(s).toContain("bash, memory_append, write, and MCP tools");
		for (const absent of ["ast_edit", "edit_v2", "recipe", "resolve", "goal_complete"]) {
			expect(s, `expected "${absent}" to be omitted from an ask session that lacks it`).not.toContain(absent);
		}
		expect(planBlockedToolNames(surface)).toEqual(["bash", "memory_append", "write"]);
	});

	it("tells the model to answer directly with read-only research", () => {
		const s = buildAskModeSection();
		expect(s).toContain("ANSWER");
		expect(s).toContain("grep");
		expect(s).toContain("/permission-mode auto");
	});
});

describe("ask-mode section selection", () => {
	it("selects ask_mode (and not plan_mode) for ask mode", () => {
		const section = buildPermissionModeSection("ask");
		expect(section).toContain("<ask_mode>");
		expect(section).not.toContain("<plan_mode>");
	});

	it("follows the live checker mode when it flips mid-session", () => {
		// The host reads `checker.mode` on the rebuild that a mode switch triggers,
		// so the resolution has to track the live checker rather than a boot value.
		const checker = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		expect(buildPermissionModeSection(checker.mode)).toContain("<plan_mode>");
		checker.updateMode("ask");
		expect(buildPermissionModeSection(checker.mode)).toContain("<ask_mode>");
		checker.updateMode("auto");
		expect(buildPermissionModeSection(checker.mode)).toBeUndefined();
	});
});

describe("/permission-mode ask", () => {
	it("accepts 'ask' and notifies with the ask label", async () => {
		const checker = new PermissionChecker({ cwd, mode: "auto", settings: {} });
		const onModeChange = vi.fn();
		const { api, commands } = makeFakePi();
		createPermissionsExtension({ cwd, checker, onModeChange })(api);
		const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn() } };
		await commands.get("permission-mode")!.handler("ask", ctx);
		expect(checker.mode).toBe("ask");
		expect(onModeChange).toHaveBeenCalledWith("ask");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Ask · read-only Q&A — answers, won't edit files", "info");
	});

	it("rejects an unknown mode and names every mode in the hint", async () => {
		const checker = new PermissionChecker({ cwd, mode: "auto", settings: {} });
		const { api, commands } = makeFakePi();
		createPermissionsExtension({ cwd, checker })(api);
		const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn() } };
		await commands.get("permission-mode")!.handler("asking", ctx);
		expect(checker.mode).toBe("auto");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Use plan | ask | confirm | auto."),
			"warning",
		);
	});
});
