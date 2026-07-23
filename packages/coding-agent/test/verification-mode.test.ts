/**
 * Verification mode (Claude Code-like default): in `in-turn` mode the model is
 * instructed via system prompt to verify BEFORE its final reply, and the
 * harness runs NOTHING after the turn — no post-reply check, no injected fix
 * turns, no self-review, no pending-checks drain. The legacy pipeline stays
 * available behind `verification.mode: "post-turn"` (or explicit `enabled: true`).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.js";

const NODE_FAIL = `node -e "process.exit(1)"`;

describe("verification.mode resolution", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	const resolve = (verification?: Record<string, unknown>) => {
		const dir = mkdtempSync(join(tmpdir(), "pit-verif-mode-"));
		tempDirs.push(dir);
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		if (verification !== undefined) {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ verification }));
		}
		return SettingsManager.create(projectDir, agentDir).getVerificationSettings().mode;
	};

	it("defaults to in-turn when nothing is set", () => {
		expect(resolve(undefined)).toBe("in-turn");
		expect(resolve({})).toBe("in-turn");
		// A configured command alone does not opt into the post-turn gate.
		expect(resolve({ command: "npm run check" })).toBe("in-turn");
	});

	it("legacy enabled maps false → off and explicit true → post-turn", () => {
		expect(resolve({ enabled: false })).toBe("off");
		expect(resolve({ enabled: true })).toBe("post-turn");
	});

	it("explicit mode wins over enabled", () => {
		expect(resolve({ mode: "in-turn", enabled: true })).toBe("in-turn");
		expect(resolve({ mode: "post-turn", enabled: false })).toBe("post-turn");
		expect(resolve({ mode: "off" })).toBe("off");
	});
});

describe("in-turn verification (default)", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("runs NOTHING after the reply: a failing configured check never fires and no fix turn is injected", async () => {
		const harness = await createHarness({ settings: { verification: { command: NODE_FAIL, maxAttempts: 2 } } });
		harnesses.push(harness);
		const file = join(harness.tempDir, "out.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("wrote it"),
		]);

		await harness.session.prompt("create out.txt");

		// The post-turn pipeline never ran: no verification lifecycle events, no
		// injected user prompts beyond the original one.
		expect(harness.eventsOfType("verification")).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["create out.txt"]);
	});

	it("injects the verify-before-replying guideline into the system prompt (with the configured command)", async () => {
		const harness = await createHarness({ settings: { verification: { command: NODE_FAIL } } });
		harnesses.push(harness);

		const prompt = harness.session.agent.state.systemPrompt ?? "";
		expect(prompt).toContain("Verify before replying");
		expect(prompt).toContain(NODE_FAIL);
	});

	it("mode off: no guideline and no post-turn pipeline", async () => {
		const harness = await createHarness({ settings: { verification: { enabled: false, command: NODE_FAIL } } });
		harnesses.push(harness);
		const file = join(harness.tempDir, "out.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("wrote it"),
		]);

		await harness.session.prompt("create out.txt");

		expect(harness.session.agent.state.systemPrompt ?? "").not.toContain("Verify before replying");
		expect(harness.eventsOfType("verification")).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["create out.txt"]);
	});

	it("post-turn mode does not get the in-turn guideline (the harness owns verification there)", async () => {
		const harness = await createHarness({
			settings: { verification: { mode: "post-turn", command: NODE_FAIL, maxAttempts: 1 } },
		});
		harnesses.push(harness);

		expect(harness.session.agent.state.systemPrompt ?? "").not.toContain("Verify before replying");
	});
});
