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

function makeFakePi(initialOrchestration: "solo" | "fusion" = "solo") {
	const handlers = new Map<string, Handler[]>();
	const sent: unknown[] = [];
	const tools: ToolDefinition[] = [];
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
		registerCommand() {},
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
	return { api, fire, sent, tools, setOrchestration };
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

	/** Register the extension against a temp cwd and approve via a real bus. */
	async function approveExitPlan(initialOrchestration: "solo" | "fusion") {
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
			bus.resolve(req.requestId, { picked: ["Approve & execute"], cancelled: false });
		});

		await exitPlan!.execute("t1", { title: "x" }, undefined, undefined, undefined as never);
		return { checker, onModeChange, setOrchestration: fake.setOrchestration };
	}

	it("approval in fusion·plan resets orchestration to solo (fusion·auto stays unreachable)", async () => {
		const { checker, onModeChange, setOrchestration } = await approveExitPlan("fusion");
		expect(checker.mode).toBe("auto");
		expect(setOrchestration).toHaveBeenCalledWith("solo");
		expect(onModeChange).toHaveBeenCalledWith("auto");
	});

	it("approval in solo·plan leaves orchestration untouched", async () => {
		const { checker, onModeChange, setOrchestration } = await approveExitPlan("solo");
		expect(checker.mode).toBe("auto");
		expect(setOrchestration).not.toHaveBeenCalled();
		expect(onModeChange).toHaveBeenCalledWith("auto");
	});
});
