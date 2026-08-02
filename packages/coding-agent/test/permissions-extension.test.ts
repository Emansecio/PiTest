import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createPermissionsExtension,
	modeDisplayLabel,
	PERMISSION_BLOCKED_CUSTOM_TYPE,
} from "../src/core/built-ins/permissions-extension.ts";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import { PermissionChecker } from "../src/core/permissions/checker.ts";
import type { PermissionMode } from "../src/core/permissions/types.ts";
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
	// The tool_call handler is async (a `confirm` decision parks on the user), so
	// every assertion on its result must await it.
	it("blocks write in plan mode and sends a permission-blocked custom message", async () => {
		const checker = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		const onDecision = vi.fn();
		const { api, fire, sent } = makeFakePi();
		createPermissionsExtension({ cwd, checker, onDecision })(api);

		const block = await fire("tool_call", {
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

	it("blocks write in ask mode with an ask-labelled reason", async () => {
		const checker = new PermissionChecker({ cwd, mode: "ask", settings: {} });
		const { api, fire, sent } = makeFakePi();
		createPermissionsExtension({ cwd, checker })(api);

		const block = await fire("tool_call", {
			toolName: "write",
			toolCallId: "t1",
			input: { path: "a.ts", content: "x" },
		});

		expect(block).toMatchObject({ block: true });
		expect(block.reason).toContain("Ask mode is read-only");
		expect(sent[0]).toMatchObject({ customType: PERMISSION_BLOCKED_CUSTOM_TYPE, display: true });
	});

	it("allows read in plan mode", async () => {
		const checker = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		const { api, fire, sent } = makeFakePi();
		createPermissionsExtension({ cwd, checker })(api);

		const block = await fire("tool_call", {
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
	function setup(initialOrchestration: "solo" | "fusion", mode: PermissionMode) {
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

	it("switching to ask from Fusion·Plan also resets orchestration (no Fusion·Ask)", async () => {
		// Ask is read-only like plan, but fusion still rides plan ONLY in v1 — the
		// user deliberately left the plan ritual, so the panel must not survive.
		const { checker, onModeChange, setOrchestration, command } = setup("fusion", "plan");
		await command.handler("ask", makeCommandCtx());
		expect(checker.mode).toBe("ask");
		expect(setOrchestration).toHaveBeenCalledWith("solo");
		expect(onModeChange).toHaveBeenCalledWith("ask");
	});

	it("switching to ask from solo·auto leaves orchestration untouched", async () => {
		const { checker, setOrchestration, command } = setup("solo", "auto");
		await command.handler("ask", makeCommandCtx());
		expect(checker.mode).toBe("ask");
		expect(setOrchestration).not.toHaveBeenCalled();
	});
});

describe("permission-cycle command — 4 stops", () => {
	/** Drive the registered `permission-cycle` handler N times and record each stop. */
	async function walk(steps: number) {
		const checker = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		const fake = makeFakePi("solo");
		createPermissionsExtension({ cwd, checker, isFusionPanelReady: () => true })(fake.api);
		const command = fake.commands.get("permission-cycle");
		expect(command).toBeDefined();
		const stops: string[] = [];
		for (let i = 0; i < steps; i++) {
			await command!.handler("", makeCommandCtx());
			stops.push(`${fake.api.getOrchestration()}·${checker.mode}`);
		}
		return stops;
	}

	it("walks plan → ask → auto → fusion·plan → plan through the real command", async () => {
		expect(await walk(4)).toEqual(["solo·ask", "solo·auto", "fusion·plan", "solo·plan"]);
	});

	it("does not enter fusion with an empty panel (nudges to /fusion instead)", async () => {
		const checker = new PermissionChecker({ cwd, mode: "auto", settings: {} });
		const onFusionNeedsSetup = vi.fn();
		const fake = makeFakePi("solo");
		createPermissionsExtension({
			cwd,
			checker,
			isFusionPanelReady: () => false,
			onFusionNeedsSetup,
		})(fake.api);
		await fake.commands.get("permission-cycle")!.handler("", makeCommandCtx());
		expect(checker.mode).toBe("auto");
		expect(onFusionNeedsSetup).toHaveBeenCalled();
	});
});

describe("modeDisplayLabel — fail-closed facet", () => {
	const label = (settings: Record<string, unknown>, orchestration: "solo" | "fusion" = "solo") =>
		modeDisplayLabel(new PermissionChecker({ cwd, mode: "auto", settings }), orchestration);

	it("shows the bare mode by default", () => {
		expect(label({})).toBe("auto");
	});

	it("suffixes the mode with fail-closed under allowlistOnly (single token, no spaces)", () => {
		const text = label({ allowlistOnly: true });
		expect(text).toBe("auto·fail-closed");
		// The footer captures `permissions:\s*(\S+)` — the suffix must survive it.
		expect(/permissions:\s*(\S+)/.exec(`permissions: ${text}`)?.[1]).toBe("auto·fail-closed");
	});

	it("lets the no-rails alarm win over fail-closed (footer keys its banner off it)", () => {
		expect(label({ allowlistOnly: true, disableBuiltinDefaults: true })).toBe("no-rails");
	});

	it("surfaces confirm as its own footer chip (not folded into auto)", () => {
		const text = modeDisplayLabel(new PermissionChecker({ cwd, mode: "confirm", settings: {} }), "solo");
		expect(text).toBe("confirm");
		// The footer only shows the chip when it differs from the boring default.
		expect(text).not.toBe("auto");
	});

	it("still composes with the fusion facet", () => {
		expect(label({ allowlistOnly: true }, "fusion")).toBe("fusion · auto·fail-closed");
	});
});
