import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createPermissionsExtension,
	PERMISSION_BLOCKED_CUSTOM_TYPE,
} from "../src/core/built-ins/permissions-extension.ts";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import { PermissionChecker } from "../src/core/permissions/checker.ts";
import { PlanManager, setCurrentPlanManager } from "../src/core/plan/plan-manager.ts";
import { createUserInputBus, setCurrentUserInputBus } from "../src/core/user-input-bus.ts";

const cwd = process.platform === "win32" ? "C:/proj" : "/proj";

type Handler = (event: any, ctx?: any) => unknown;

type CommandDef = { handler: (args: string, ctx: any) => unknown };

function makeFakePi(initialOrchestration: "solo" | "fusion" = "solo") {
	const handlers = new Map<string, Handler[]>();
	const sent: unknown[] = [];
	const tools: ToolDefinition[] = [];
	const commands = new Map<string, CommandDef>();
	let orchestration: "solo" | "fusion" = initialOrchestration;
	const setOrchestration = vi.fn((o: "solo" | "fusion") => {
		orchestration = o;
	});
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
		registerCommand(name: string, def: CommandDef) {
			commands.set(name, def);
		},
		sendMessage(message: unknown) {
			sent.push(message);
		},
		getOrchestration: () => orchestration,
		setOrchestration,
	} as unknown as ExtensionAPI;
	const fire = (event: string, payload: any, ctx?: any): any => {
		let result: any;
		for (const handler of handlers.get(event) ?? []) {
			const r = handler(payload, ctx);
			if (r !== undefined && result === undefined) result = r;
		}
		return result;
	};
	return { api, fire, sent, tools, commands, setOrchestration };
}

/** Minimal ctx for a slash-command handler (ui.notify + ui.setStatus). */
function makeCommandCtx() {
	return { ui: { notify: vi.fn(), setStatus: vi.fn() } };
}

describe("permissions-extension tool_call deny", () => {
	it("blocks write in plan mode and sends a permission-blocked custom message", () => {
		const checker = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		const onDecision = vi.fn();
		const { api, fire, sent } = makeFakePi();
		createPermissionsExtension({ cwd, checker, onDecision })(api);

		const block = fire("tool_call", {
			toolName: "write",
			toolCallId: "t1",
			input: { path: "a.ts", content: "x" },
		});

		expect(block).toMatchObject({ block: true });
		expect(typeof block.reason).toBe("string");
		expect(sent[0]).toMatchObject({
			customType: PERMISSION_BLOCKED_CUSTOM_TYPE,
			display: true,
		});
		expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ toolName: "write", decision: "deny" }));
	});

	it("allows read in plan mode", () => {
		const checker = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		const { api, fire, sent } = makeFakePi();
		createPermissionsExtension({ cwd, checker })(api);

		const block = fire("tool_call", {
			toolName: "read",
			toolCallId: "t1",
			input: { path: "a.ts" },
		});
		expect(block).toBeUndefined();
		expect(sent).toHaveLength(0);
	});
});

describe("exit_plan approval and orchestration", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) {
			const d = dirs.pop();
			if (d) {
				try {
					rmSync(d, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
			}
		}
		setCurrentPlanManager(undefined);
		setCurrentUserInputBus(undefined);
	});

	/** Register the extension against a temp cwd and drive exit_plan via a real bus. */
	async function runExitPlanChoosing(initialOrchestration: "solo" | "fusion", picked = "Approve & execute") {
		const dir = mkdtempSync(join(tmpdir(), "pi-permext-"));
		dirs.push(dir);
		const checker = new PermissionChecker({ cwd: dir, mode: "plan", settings: {} });
		const onModeChange = vi.fn();
		const fake = makeFakePi(initialOrchestration);
		createPermissionsExtension({ cwd: dir, checker, onModeChange })(fake.api);
		const exitPlan = fake.tools.find((t) => t.name === "exit_plan");
		expect(exitPlan).toBeDefined();

		const mgr = new PlanManager();
		mgr.propose([{ id: "s1", intent: "do the thing" }]);
		setCurrentPlanManager(mgr);
		const bus = createUserInputBus();
		setCurrentUserInputBus(bus);
		bus.onRequest((req) => {
			bus.resolve(req.requestId, { picked: [picked], cancelled: false });
		});

		await exitPlan!.execute("t1", { title: "x" }, undefined, undefined, undefined as never);
		return { checker, onModeChange, setOrchestration: fake.setOrchestration };
	}

	it("approval in fusion·plan resets orchestration to solo (fusion·auto stays unreachable)", async () => {
		const { checker, onModeChange, setOrchestration } = await runExitPlanChoosing("fusion");
		expect(checker.mode).toBe("auto");
		expect(setOrchestration).toHaveBeenCalledWith("solo");
		expect(onModeChange).toHaveBeenCalledWith("auto");
	});

	it("approval in solo·plan leaves orchestration untouched", async () => {
		const { checker, onModeChange, setOrchestration } = await runExitPlanChoosing("solo");
		expect(checker.mode).toBe("auto");
		expect(setOrchestration).not.toHaveBeenCalled();
		expect(onModeChange).toHaveBeenCalledWith("auto");
	});

	it("rejecting the plan (Keep planning) in fusion·plan does NOT reset orchestration", async () => {
		// Only APPROVAL leaves plan mode, so only approval may drop fusion. A rejection
		// must stay in Fusion·Plan (orchestration untouched, still read-only).
		const { checker, onModeChange, setOrchestration } = await runExitPlanChoosing("fusion", "Keep planning");
		expect(checker.mode).toBe("plan");
		expect(setOrchestration).not.toHaveBeenCalled();
		expect(onModeChange).not.toHaveBeenCalled();
	});
});

describe("/permission-mode and the fusion invariant", () => {
	/** Register the extension and return its `permission-mode` command handler. */
	function setup(initialOrchestration: "solo" | "fusion", mode: "plan" | "auto") {
		const checker = new PermissionChecker({ cwd, mode, settings: {} });
		const onModeChange = vi.fn();
		const fake = makeFakePi(initialOrchestration);
		createPermissionsExtension({ cwd, checker, onModeChange })(fake.api);
		const command = fake.commands.get("permission-mode");
		expect(command).toBeDefined();
		return { checker, onModeChange, setOrchestration: fake.setOrchestration, command: command! };
	}

	it("switching to auto from Fusion·Plan resets orchestration to solo", async () => {
		const { checker, onModeChange, setOrchestration, command } = setup("fusion", "plan");
		await command.handler("auto", makeCommandCtx());
		expect(checker.mode).toBe("auto");
		expect(setOrchestration).toHaveBeenCalledWith("solo");
		expect(onModeChange).toHaveBeenCalledWith("auto");
	});

	it("switching to auto from solo leaves orchestration untouched", async () => {
		const { checker, setOrchestration, command } = setup("solo", "plan");
		await command.handler("auto", makeCommandCtx());
		expect(checker.mode).toBe("auto");
		expect(setOrchestration).not.toHaveBeenCalled();
	});

	it("switching to plan from Fusion·Plan keeps fusion (legal pairing, no reset)", async () => {
		const { checker, setOrchestration, command } = setup("fusion", "plan");
		await command.handler("plan", makeCommandCtx());
		expect(checker.mode).toBe("plan");
		expect(setOrchestration).not.toHaveBeenCalled();
	});
});
