/**
 * Regression: the coordinator extension must see the parent's CURRENT model and
 * tool catalog at spawn time. `__bindBuiltInRefs` used to capture both as
 * values right after session construction, but `/model` swaps
 * `agent.state.model` and `setActiveToolsByName` reassigns `agent.state.tools`
 * (a fresh array) — so a subagent spawned later would inherit the boot-time
 * model/catalog. The refs are now getters; this test flips both and asserts the
 * child observes the post-switch state.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Model } from "@pit/ai";
import { fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SessionManager } from "../src/core/session-manager.js";

describe("coordinator parent refs stay live after model/tool-surface changes", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("a subagent spawned after /model + setActiveToolsByName sees the new model and catalog", async () => {
		const tempDir = join(tmpdir(), `pi-coord-refs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [{ id: "boot-model" }, { id: "switched-model" }],
		});
		const bootModel = faux.getModel("boot-model")!;
		const switchedModel = faux.getModel("switched-model")!;

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(bootModel.provider, "faux-key");

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			model: bootModel,
		});
		cleanups.push(async () => {
			await session.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				try {
					rmSync(tempDir, { recursive: true, force: true });
				} catch {
					// Best-effort on Windows handle-release races.
				}
			}
		});
		await session.bindExtensions({});

		// Grab the coordinator's `task` tool from the boot surface, then change
		// BOTH the model and the active tool surface out from under it.
		const taskTool = session.agent.state.tools.find((tool) => tool.name === "task");
		expect(taskTool).toBeDefined();
		expect(session.agent.state.tools.some((tool) => tool.name === "grep")).toBe(true);
		await session.setModel(switchedModel);
		session.setActiveToolsByName(["read"]);

		// The child's provider call exposes the model and tool catalog it runs with.
		let childModelId: string | undefined;
		let childToolNames: string[] = [];
		faux.setResponses([
			(ctx: Context, _opts, _state, model: Model<string>) => {
				childModelId = model.id;
				childToolNames = (ctx.tools ?? []).map((tool) => tool.name);
				return fauxAssistantMessage("child-done");
			},
		]);

		const result = await taskTool!.execute("tc-1", { prompt: "say done" }, undefined as never);
		expect(JSON.stringify(result.content)).toContain("child-done");

		expect(childModelId).toBe("switched-model");
		expect(childToolNames).toContain("read");
		// The boot catalog had grep; a stale snapshot would leak it to the child.
		expect(childToolNames).not.toContain("grep");
	}, 30_000);
});
