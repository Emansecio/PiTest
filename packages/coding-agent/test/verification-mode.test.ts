/**
 * Verification mode (Claude Code-like default): in `in-turn` mode the model is
 * instructed via system prompt to verify BEFORE its final reply, and the harness
 * runs NO CHECK of its own — no post-reply check command, no fix loop, no
 * pending-checks drain. It is not blind, though: a cycle that edited files and
 * ran no check at all gets ONE corrective turn (in-turn grounding). The legacy
 * pipeline stays available behind `verification.mode: "post-turn"` (or explicit
 * `enabled: true`).
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

	it("never RUNS the configured check itself, but corrects the cycle that skipped it", async () => {
		const harness = await createHarness({ settings: { verification: { command: NODE_FAIL, maxAttempts: 2 } } });
		harnesses.push(harness);
		const file = join(harness.tempDir, "out.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("wrote it"),
			fauxAssistantMessage("ok, ran it"),
		]);

		await harness.session.prompt("create out.txt");

		// The post-turn pipeline never ran: the failing command was never executed,
		// so no verification lifecycle event exists (that is what `mode: in-turn` buys).
		expect(harness.eventsOfType("verification")).toEqual([]);
		// But the honour-gap is not silent: the model edited a file and ran no check,
		// so exactly ONE corrective turn naming the command was injected.
		const texts = getUserTexts(harness);
		expect(texts).toHaveLength(2);
		expect(texts[0]).toBe("create out.txt");
		expect(texts[1]).toContain(NODE_FAIL);
		expect(texts[1]).toContain("never ran the project's check");
	});

	it("stays silent when the model DID run a check during the turn", async () => {
		const harness = await createHarness({ settings: { verification: { command: NODE_FAIL, maxAttempts: 2 } } });
		harnesses.push(harness);
		const file = join(harness.tempDir, "out.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "hi" })], { stopReason: "toolUse" }),
			// Classified as verification-class by `isVerificationJobCommand` (names a
			// test runner); harmless to execute, which keeps this test fast.
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo running vitest" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("wrote it and checked"),
		]);

		await harness.session.prompt("create out.txt");

		expect(harness.eventsOfType("verification")).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["create out.txt"]);
	});

	it("stays silent on a read-only cycle", async () => {
		const harness = await createHarness({ settings: { verification: { command: NODE_FAIL } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("nothing to change")]);

		await harness.session.prompt("what does out.txt do?");

		expect(getUserTexts(harness)).toEqual(["what does out.txt do?"]);
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
