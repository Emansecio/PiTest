/**
 * Acceptance gate tests — judge criteria, shell checks, retry, and graceful degradation.
 */

import type { AgentMessage } from "@pit/agent-core";
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { runWithAcceptance } from "../src/core/coordinator/acceptance.js";
import { SubagentRegistry } from "../src/core/coordinator/registry.js";
import type { SpawnSubagentDependencies } from "../src/core/coordinator/spawn.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { PermissionChecker } from "../src/core/permissions/index.js";

interface Rig {
	faux: FauxProviderRegistration;
	deps: SpawnSubagentDependencies;
	dispose: () => void;
}

function createRig(opts?: { permissionChecker?: PermissionChecker }): Rig {
	const faux = registerFauxProvider();
	faux.setResponses([]);
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const registry = new SubagentRegistry();
	const deps: SpawnSubagentDependencies = {
		registry,
		model,
		modelRegistry,
		availableTools: [],
		convertToLlm: (messages: AgentMessage[]) => convertToLlm(messages),
		permissionChecker: opts?.permissionChecker,
	};
	return { faux, deps, dispose: () => faux.unregister() };
}

describe("runWithAcceptance", () => {
	const rigs: Rig[] = [];
	afterEach(() => {
		while (rigs.length > 0) rigs.pop()?.dispose();
	});

	function rig(opts?: { permissionChecker?: PermissionChecker }) {
		const r = createRig(opts);
		rigs.push(r);
		return r;
	}

	it("no-op when acceptance has neither criteria nor check", async () => {
		const { faux, deps } = rig();
		faux.setResponses([fauxAssistantMessage("plain output")]);
		const result = await runWithAcceptance(deps, { prompt: "p", taskName: "plain" }, {});
		expect(result.isError).toBe(false);
		expect(result.text).toBe("plain output");
		expect(result.gate).toBeUndefined();
	});

	it("gate pass on first attempt (criteria)", async () => {
		const { faux, deps } = rig();
		faux.setResponses([
			fauxAssistantMessage("worker answer"),
			fauxAssistantMessage(`\`\`\`json\n${JSON.stringify({ pass: true, reasons: "looks good" })}\n\`\`\``),
		]);
		const result = await runWithAcceptance(
			deps,
			{ prompt: "do work", taskName: "gate-pass", depth: 0 },
			{ criteria: "output must mention the answer" },
		);
		expect(result.isError).toBe(false);
		expect(result.gate?.passed).toBe(true);
		expect(result.gate?.attempts).toBe(1);
	});

	it("gate fail then retry then pass", async () => {
		const { faux, deps } = rig();
		faux.setResponses([
			fauxAssistantMessage("incomplete"),
			fauxAssistantMessage(`\`\`\`json\n${JSON.stringify({ pass: false, reasons: "missing detail" })}\n\`\`\``),
			fauxAssistantMessage("complete answer"),
			fauxAssistantMessage(`\`\`\`json\n${JSON.stringify({ pass: true, reasons: "now complete" })}\n\`\`\``),
		]);
		const result = await runWithAcceptance(
			deps,
			{ prompt: "do work", taskName: "retry-pass", depth: 0 },
			{ criteria: "must be complete", max_attempts: 2 },
		);
		expect(result.isError).toBe(false);
		expect(result.gate?.passed).toBe(true);
		expect(result.gate?.attempts).toBe(2);
	});

	it("exhaustion returns last output flagged, isError:false", async () => {
		const { faux, deps } = rig();
		faux.setResponses([
			fauxAssistantMessage("attempt one"),
			fauxAssistantMessage(`\`\`\`json\n${JSON.stringify({ pass: false, reasons: "bad" })}\n\`\`\``),
			fauxAssistantMessage("attempt two"),
			fauxAssistantMessage(`\`\`\`json\n${JSON.stringify({ pass: false, reasons: "still bad" })}\n\`\`\``),
		]);
		const result = await runWithAcceptance(
			deps,
			{ prompt: "do work", taskName: "exhaust", depth: 0 },
			{ criteria: "high bar", max_attempts: 2 },
		);
		expect(result.isError).toBe(false);
		expect(result.text).toContain("⚠ Acceptance gate not satisfied after 2 attempts");
		expect(result.text).toContain("attempt two");
		expect(result.gate?.passed).toBe(false);
		expect(result.gate?.exhausted).toBe(true);
	});

	it("command check pass (exit 0)", async () => {
		const { faux, deps } = rig();
		faux.setResponses([fauxAssistantMessage("done")]);
		const cmd = process.platform === "win32" ? "exit 0" : "true";
		const result = await runWithAcceptance(deps, { prompt: "p", taskName: "check-pass", depth: 0 }, { check: cmd });
		expect(result.isError).toBe(false);
		expect(result.gate?.passed).toBe(true);
		expect(result.gate?.check_pass).toBe(true);
	});

	it("command check fail (non-zero exit)", async () => {
		const { faux, deps } = rig();
		faux.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage(`\`\`\`json\n${JSON.stringify({ pass: false, reasons: "n/a" })}\n\`\`\``),
			fauxAssistantMessage("second"),
		]);
		const cmd = process.platform === "win32" ? "exit 1" : "false";
		const result = await runWithAcceptance(
			deps,
			{ prompt: "p", taskName: "check-fail", depth: 0, cwd: process.cwd() },
			{ check: cmd, max_attempts: 1 },
		);
		expect(result.isError).toBe(false);
		expect(result.gate?.passed).toBe(false);
		expect(result.gate?.exhausted).toBe(true);
	});

	it("permission-denied check fails closed", async () => {
		const { faux, deps } = rig({
			permissionChecker: new PermissionChecker({
				cwd: process.cwd(),
				mode: "plan",
				settings: {},
			}),
		});
		faux.setResponses([fauxAssistantMessage("worker out")]);
		const result = await runWithAcceptance(
			deps,
			{ prompt: "p", taskName: "perm-deny", depth: 0 },
			{ check: "echo hi", max_attempts: 1 },
		);
		expect(result.isError).toBe(false);
		expect(result.gate?.passed).toBe(false);
		expect(result.gate?.exhausted).toBe(true);
	});

	it("real worker throw propagates as isError (via spawn throw)", async () => {
		const { faux, deps } = rig();
		const schema = Type.Object({ ok: Type.Boolean() });
		faux.setResponses([fauxAssistantMessage("not json")]);
		await expect(
			runWithAcceptance(
				deps,
				{ prompt: "p", taskName: "throw", depth: 0, resultSchema: schema },
				{ criteria: "unused" },
			),
		).rejects.toThrow(/resultSchema/);
	});

	it("judge receives worker output in prompt", async () => {
		const { faux, deps } = rig();
		let judgeUserPrompt = "";
		faux.setResponses([
			fauxAssistantMessage("THE_WORKER_OUTPUT"),
			(context) => {
				const userMsg = context.messages?.find((m) => m.role === "user");
				if (userMsg && "content" in userMsg) {
					const blocks = userMsg.content;
					if (typeof blocks === "string") judgeUserPrompt = blocks;
					else if (Array.isArray(blocks)) {
						judgeUserPrompt = blocks
							.filter((b): b is { type: "text"; text: string } => b.type === "text")
							.map((b) => b.text)
							.join("\n");
					}
				}
				return fauxAssistantMessage(`\`\`\`json\n${JSON.stringify({ pass: true, reasons: "ok" })}\n\`\`\``);
			},
		]);
		await runWithAcceptance(
			deps,
			{ prompt: "p", taskName: "judge-prompt", depth: 0 },
			{ criteria: "must include THE_WORKER_OUTPUT" },
		);
		expect(judgeUserPrompt).toContain("THE_WORKER_OUTPUT");
	});
});
