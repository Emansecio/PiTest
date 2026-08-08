import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("plan runtime verify timeout wiring", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("passes verification.planStepTimeoutMs into the session's actual plan tool", async () => {
		const cwd = join(tmpdir(), `pit-plan-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
		const faux = registerFauxProvider();
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const settingsManager = SettingsManager.inMemory({ verification: { planStepTimeoutMs: 125 } });
		const services = await createAgentSessionServices({
			cwd,
			agentDir: cwd,
			authStorage,
			settingsManager,
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			model,
		});
		cleanups.push(async () => {
			await session.dispose();
			faux.unregister();
			if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
		});

		session.setActiveToolsByName(["plan"]);
		const plan = session.agent.state.tools.find((tool) => tool.name === "plan");
		expect(plan).toBeDefined();
		let runtimeTimeoutMs: number | undefined;
		vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
			runtimeTimeoutMs = milliseconds;
			return AbortSignal.abort(new Error("test timeout"));
		});
		const command = `"${process.execPath}" -e "setTimeout(() => {}, 2000)"`;
		await plan!.execute("propose", {
			op: "propose",
			steps: [{ id: "s1", intent: "verify timeout", verify_command: command }],
		});
		const result = await plan!.execute("done", { op: "step_done", step_id: "s1" });

		expect(runtimeTimeoutMs).toBe(125);
		expect(JSON.stringify(result.content)).toContain("timed out after 125ms");
	}, 15_000);

	it.each(["plan", "ask"] as const)("does not execute plan verification in %s mode", async (mode) => {
		const cwd = join(tmpdir(), `pit-plan-readonly-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
		const faux = registerFauxProvider();
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const services = await createAgentSessionServices({
			cwd,
			agentDir: cwd,
			authStorage,
			settingsManager: SettingsManager.inMemory({ permissions: { mode } }),
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			model,
		});
		cleanups.push(async () => {
			await session.dispose();
			faux.unregister();
			if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
		});

		session.setActiveToolsByName(["plan"]);
		const plan = session.agent.state.tools.find((tool) => tool.name === "plan");
		expect(plan).toBeDefined();
		const timeout = vi.spyOn(AbortSignal, "timeout");
		await plan!.execute("propose", {
			op: "propose",
			steps: [{ id: "s1", intent: "verify safely", verify_command: `"${process.execPath}" --version` }],
		});
		const result = await plan!.execute("done", { op: "step_done", step_id: "s1" });

		expect(timeout).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toMatch(/read-only permission mode/i);
	});
});
