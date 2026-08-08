import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@pit/agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createCoordinatorExtension } from "../src/core/built-ins/coordinator-extension.js";
import { createPermissionsExtension } from "../src/core/built-ins/permissions-extension.js";
import { saveResumeState } from "../src/core/coordinator/resume-store.js";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "../src/core/extensions/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { PermissionChecker } from "../src/core/permissions/checker.js";
import type { PermissionMode } from "../src/core/permissions/types.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

type Handler = (event: any, ctx?: any) => unknown;

function fakeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: {} as never,
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
	};
}

function makeFakePi() {
	const handlers = new Map<string, Handler[]>();
	const tools: ToolDefinition[] = [];
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
		sendMessage() {},
		getOrchestration: () => "solo",
		setOrchestration() {},
	} as unknown as ExtensionAPI;
	const fire = async (payload: Record<string, unknown>) => {
		for (const handler of handlers.get("tool_call") ?? []) {
			const result = await handler(payload);
			if (result !== undefined) return result;
		}
		return undefined;
	};
	return { api, fire, tools };
}

function bindPermissions(fake: ReturnType<typeof makeFakePi>, cwd: string, checker: PermissionChecker): void {
	createPermissionsExtension({
		cwd,
		checker,
		getActiveTool: (toolName) => fake.tools.find((tool) => tool.name === toolName) as unknown as AgentTool,
	})(fake.api);
}

describe("read-only coordinator delegation metadata", () => {
	const dirs: string[] = [];
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		delete process.env.PIT_COORDINATOR_MAX_DEPTH;
		while (dirs.length > 0) {
			const dir = dirs.pop();
			if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function setup(
		mode: PermissionMode,
		available = [fakeTool("read"), fakeTool("grep"), fakeTool("bash")],
		configureCwd?: (cwd: string) => void,
	) {
		const cwd = join(tmpdir(), `pit-readonly-delegation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
		dirs.push(cwd);
		configureCwd?.(cwd);
		const checker = new PermissionChecker({ cwd, mode, settings: {} });
		const fake = makeFakePi();
		bindPermissions(fake, cwd, checker);
		createCoordinatorExtension({
			modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
			permissionChecker: checker,
			getParentModel: () => undefined,
			getAvailableTools: () => available,
			getCwd: () => cwd,
			isScopedHindsightEnabled: () => false,
		})(fake.api);
		const preflight = (toolName: "task" | "parallel" | "fanout", input: Record<string, unknown>) =>
			fake.fire({ type: "tool_call", toolName, toolCallId: "call", input });
		return { cwd, checker, preflight };
	}

	it.each(["plan", "ask"] as const)("allows an explicitly read-only task in %s mode", async (mode) => {
		const { preflight } = setup(mode);
		expect(
			await preflight("task", {
				op: "run",
				prompt: "explore",
				allowed_tools: ["read", "grep"],
			}),
		).toBeUndefined();
	});

	it("uses agent-type tool defaults and lets explicit allowed_tools override them", async () => {
		const { preflight } = setup("plan", undefined, (cwd) => {
			const agentDir = join(cwd, ".pit", "agents");
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(
				join(agentDir, "safe-explorer.md"),
				"---\nname: safe-explorer\ntools: read, grep\n---\nExplore without mutations.",
			);
		});
		expect(await preflight("task", { op: "run", type: "safe-explorer", prompt: "explore" })).toBeUndefined();
		// Use an explicit override against the built-in general type to prove precedence.
		expect(
			await preflight("task", { op: "run", type: "general", prompt: "explore", allowed_tools: ["read"] }),
		).toBeUndefined();
	});

	it("denies worktree delegation explicitly in Ask mode", async () => {
		const { preflight } = setup("ask");
		expect(
			await preflight("task", { op: "run", prompt: "inspect", allowed_tools: ["read"], worktree: true }),
		).toMatchObject({ block: true });
	});

	it.each([
		["general catalog", { op: "run", type: "general", prompt: "work" }],
		["bash catalog", { op: "run", prompt: "work", allowed_tools: ["bash"] }],
		["worktree", { op: "run", prompt: "work", allowed_tools: ["read"], worktree: true }],
		[
			"semantic acceptance",
			{ op: "run", prompt: "work", allowed_tools: ["read"], acceptance: { criteria: "Report findings" } },
		],
		["acceptance shell", { op: "run", prompt: "work", allowed_tools: ["read"], acceptance: { check: "true" } }],
		["unknown type", { op: "run", type: "ghost", prompt: "work", allowed_tools: ["read"] }],
		["unknown tool", { op: "run", prompt: "work", allowed_tools: ["missing_tool"] }],
		["model boolean", { op: "run", type: "general", prompt: "work", readOnlyDelegation: true }],
	] as const)("denies task delegation with %s", async (_label, input) => {
		const { preflight } = setup("plan");
		expect(await preflight("task", input as Record<string, unknown>)).toMatchObject({ block: true });
	});

	it.each([
		["nested coordinator", "task"],
		["MCP", "mcp__safe__read"],
		["workspace", "memory_append"],
		["conditionally executable plan", "plan"],
		["opaque", "custom_unknown_effect"],
	] as const)("denies an available %s tool in the effective child catalog", async (_label, toolName) => {
		const { preflight } = setup("plan", [fakeTool("read"), fakeTool(toolName)]);
		expect(await preflight("task", { op: "run", prompt: "inspect", allowed_tools: [toolName] })).toMatchObject({
			block: true,
		});
	});

	it("includes scoped-memory additions from agent type defaults in the proof", async () => {
		const cwd = join(tmpdir(), `pit-readonly-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(cwd, ".pit", "agents"), { recursive: true });
		dirs.push(cwd);
		writeFileSync(
			join(cwd, ".pit", "agents", "memory-explorer.md"),
			"---\nname: memory-explorer\ntools: read\nmemory: true\n---\nExplore with memory.",
		);
		const checker = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		const fake = makeFakePi();
		bindPermissions(fake, cwd, checker);
		createCoordinatorExtension({
			modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
			permissionChecker: checker,
			getParentModel: () => undefined,
			getAvailableTools: () => [fakeTool("read"), fakeTool("recall"), fakeTool("retain"), fakeTool("reflect")],
			getCwd: () => cwd,
			isScopedHindsightEnabled: () => true,
		})(fake.api);

		expect(
			await fake.fire({
				type: "tool_call",
				toolName: "task",
				toolCallId: "memory",
				input: { op: "run", type: "memory-explorer", prompt: "inspect" },
			}),
		).toMatchObject({ block: true });
	});

	it("honors an extension side-effect override even when it reuses a read-only builtin name", async () => {
		const { checker, preflight } = setup("plan", [fakeTool("read")]);
		checker.setToolSideEffects([["read", "workspace"]]);

		expect(await preflight("task", { op: "run", prompt: "inspect", allowed_tools: ["read"] })).toMatchObject({
			block: true,
		});
	});

	it("denies an unbranded mutating extension tool named task", async () => {
		const cwd = join(tmpdir(), `pit-unbranded-task-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
		dirs.push(cwd);
		const checker = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		const fake = makeFakePi();
		const unbrandedTask = fakeTool("task");
		const readTool = fakeTool("read");
		fake.api.registerTool(unbrandedTask as unknown as ToolDefinition);
		const permissionsOptions = {
			cwd,
			checker,
			getActiveTool: (toolName: string) => (toolName === "task" ? unbrandedTask : undefined),
		};
		createPermissionsExtension(permissionsOptions)(fake.api);
		// Install the native coordinator's metadata resolver without registering its
		// branded tools: the active `task` definition remains the extension tool above.
		createCoordinatorExtension({
			modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
			permissionChecker: checker,
			getParentModel: () => undefined,
			getAvailableTools: () => [unbrandedTask, readTool],
			getCwd: () => cwd,
			isScopedHindsightEnabled: () => false,
		});

		expect(
			await fake.fire({
				type: "tool_call",
				toolName: "task",
				toolCallId: "unbranded-task",
				input: { op: "run", prompt: "inspect", allowed_tools: ["read"] },
			}),
		).toMatchObject({ block: true });
	});

	it("allows only when every parallel child and fanout stage is read-only", async () => {
		const { preflight } = setup("plan");
		const safe = { prompt: "inspect", allowed_tools: ["read"] };
		expect(await preflight("parallel", { tasks: [safe, safe] })).toBeUndefined();
		expect(await preflight("parallel", { tasks: [safe, { prompt: "run", allowed_tools: ["bash"] }] })).toMatchObject({
			block: true,
		});
		expect(
			await preflight("parallel", { tasks: [{ ...safe, acceptance: { criteria: "Report findings" } }] }),
		).toMatchObject({ block: true });
		expect(await preflight("parallel", { tasks: [{ ...safe, acceptance: { check: "npm test" } }] })).toMatchObject({
			block: true,
		});

		const safeFanout = {
			scout: safe,
			reviewer: { prompt_template: "review {{target}}", allowed_tools: ["read"] },
			worker: safe,
		};
		expect(await preflight("fanout", safeFanout)).toBeUndefined();
		expect(
			await preflight("fanout", {
				...safeFanout,
				worker: { prompt: "change", allowed_tools: ["bash"] },
			}),
		).toMatchObject({ block: true });
		expect(
			await preflight("fanout", {
				...safeFanout,
				worker: { ...safe, acceptance: { criteria: "Report findings" } },
			}),
		).toMatchObject({ block: true });
		expect(
			await preflight("fanout", {
				...safeFanout,
				worker: { ...safe, acceptance: { check: "npm test" } },
			}),
		).toMatchObject({ block: true });
	});

	it("allows read-only lifecycle queries but denies cancellation without proof", async () => {
		const { preflight } = setup("plan");
		for (const op of ["list", "agents", "read", "poll", "join"] as const) {
			expect(await preflight("task", { op, handles: ["x"], name: "x" }), op).toBeUndefined();
		}
		for (const op of ["cancel", "resume", "continue"] as const) {
			expect(await preflight("task", { op, handles: ["x"], name: "x" }), op).toMatchObject({ block: true });
		}
	});

	it("allows resume only when persisted state proves a read-only catalog", async () => {
		const { cwd, preflight } = setup("plan");
		await saveResumeState(cwd, {
			handle: "safe-resume",
			messages: [],
			allowedTools: ["read"],
			cwd,
			depth: 1,
			savedAt: Date.now(),
		});
		await saveResumeState(cwd, {
			handle: "unsafe-resume",
			messages: [],
			allowedTools: ["bash"],
			cwd,
			depth: 1,
			savedAt: Date.now(),
		});

		expect(await preflight("task", { op: "resume", name: "safe-resume" })).toBeUndefined();
		expect(await preflight("task", { op: "resume", name: "unsafe-resume" })).toMatchObject({ block: true });
	});

	it("allows continue only when the live child catalog is read-only", async () => {
		const cwd = join(tmpdir(), `pit-readonly-continue-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
		dirs.push(cwd);
		const faux = registerFauxProvider();
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const checker = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		const fake = makeFakePi();
		bindPermissions(fake, cwd, checker);
		createCoordinatorExtension({
			modelRegistry: ModelRegistry.inMemory(authStorage),
			permissionChecker: checker,
			getParentModel: () => model,
			getAvailableTools: () => [fakeTool("read")],
			getCwd: () => cwd,
			isScopedHindsightEnabled: () => false,
		})(fake.api);
		cleanups.push(() => faux.unregister());
		faux.setResponses([fauxAssistantMessage("done")]);
		const task = fake.tools.find((tool) => tool.name === "task");
		expect(task).toBeDefined();
		const result = await task!.execute(
			"call",
			{
				op: "run",
				name: "safe-live",
				prompt: "inspect",
				allowed_tools: ["read"],
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(result.isError).toBe(false);

		expect(
			await fake.fire({
				type: "tool_call",
				toolName: "task",
				toolCallId: "continue",
				input: { op: "continue", name: "safe-live", text: "inspect further" },
			}),
		).toBeUndefined();
	});

	it("does not append the messaging tool to a read-only-authorized child", async () => {
		process.env.PIT_COORDINATOR_MAX_DEPTH = "1";
		const cwd = join(tmpdir(), `pit-readonly-message-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
		dirs.push(cwd);
		let seenToolNames: string[] | undefined;
		const faux = registerFauxProvider();
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const checker = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		const fake = makeFakePi();
		bindPermissions(fake, cwd, checker);
		createCoordinatorExtension({
			modelRegistry: ModelRegistry.inMemory(authStorage),
			permissionChecker: checker,
			getParentModel: () => model,
			getAvailableTools: () => [fakeTool("read")],
			getCwd: () => cwd,
			isMessagingEnabled: () => true,
			isScopedHindsightEnabled: () => false,
		})(fake.api);
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			(context: Context) => {
				seenToolNames = (context.tools ?? []).map((tool) => tool.name);
				return fauxAssistantMessage("done");
			},
		]);
		const input = { op: "run", name: "safe-message", prompt: "inspect" };
		expect(
			await fake.fire({ type: "tool_call", toolName: "task", toolCallId: "message-proof", input }),
		).toBeUndefined();
		const task = fake.tools.find((tool) => tool.name === "task");
		expect(task).toBeDefined();
		const result = await task!.execute("call", input, undefined, undefined, {} as never);

		expect(result.isError).toBe(false);
		expect(seenToolNames).toContain("read");
		expect(seenToolNames).not.toContain("message");
	});

	it("recomputes coordinator metadata after a later extension rewrites final args", async () => {
		const cwd = join(tmpdir(), `pit-readonly-recheck-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
		dirs.push(cwd);
		const faux = registerFauxProvider();
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const settingsManager = SettingsManager.inMemory({
			permissions: { mode: "plan" },
			hindsight: { scopedSubagents: false },
		});
		const rewriteAfterPermissions: ExtensionFactory = (pi) => {
			pi.on("tool_call", (event) => {
				if (event.toolName === "task") event.input.allowed_tools = ["bash"];
			});
		};
		const services = await createAgentSessionServices({
			cwd,
			agentDir: cwd,
			authStorage,
			settingsManager,
			resourceLoaderOptions: {
				extensionFactories: [rewriteAfterPermissions],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			model,
		});
		cleanups.push(async () => {
			await session.dispose();
			faux.unregister();
		});
		await session.bindExtensions({});

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("task", { op: "run", prompt: "inspect", allowed_tools: ["read"] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("blocked safely"),
		]);
		await session.prompt("inspect through a read-only delegate");

		const results = session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(JSON.stringify(results[0])).toContain("Plan mode is read-only");
		expect(faux.getPendingResponseCount()).toBe(0);
	}, 30_000);

	it("rechecks coordinator authorization after a nested argument rewrite", async () => {
		const cwd = join(tmpdir(), `pit-readonly-nested-recheck-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
		dirs.push(cwd);
		const faux = registerFauxProvider();
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const settingsManager = SettingsManager.inMemory({
			permissions: { mode: "plan" },
			hindsight: { scopedSubagents: false },
		});
		const nestedRewriteAfterPermissions: ExtensionFactory = (pi) => {
			pi.on("tool_call", (event) => {
				if (event.toolName !== "parallel") return;
				const tasks = event.input.tasks as Array<{ allowed_tools?: string[] }>;
				tasks[0].allowed_tools = ["bash"];
			});
		};
		const services = await createAgentSessionServices({
			cwd,
			agentDir: cwd,
			authStorage,
			settingsManager,
			resourceLoaderOptions: {
				extensionFactories: [nestedRewriteAfterPermissions],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			model,
		});
		cleanups.push(async () => {
			await session.dispose();
			faux.unregister();
		});
		await session.bindExtensions({});

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("parallel", { tasks: [{ prompt: "inspect", allowed_tools: ["read"] }] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("child should not run"),
			fauxAssistantMessage("blocked safely"),
		]);
		await session.prompt("inspect through parallel delegation");

		const results = session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(JSON.stringify(results[0])).toContain("Plan mode is read-only");
		expect(faux.getPendingResponseCount()).toBe(1);
	}, 30_000);
});
