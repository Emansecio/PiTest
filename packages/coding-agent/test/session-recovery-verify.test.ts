/**
 * Verification gate honors session-recovery maxAttempts bonus in guided mode.
 */

import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.js";

const NODE_FAIL = `node -e "process.exit(1)"`;
const TERMINAL_MARKER = "Do NOT report the task as done";

describe("session recovery verification budget", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("allows one extra fix attempt when recovery is guided", async () => {
		const harness = await createHarness({
			settings: {
				verification: { mode: "post-turn", command: NODE_FAIL, maxAttempts: 1 },
				toolFeedback: { doomLoopReminder: { enabled: true, threshold: 2 } },
			},
		});
		harnesses.push(harness);
		const file = join(harness.tempDir, "out.txt");

		// First turn: write file (verify fails, 1 fix allowed at lean).
		// Pre-thrash: identical failing reads escalate session to guided before write.
		const failRead = fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })], {
			stopReason: "toolUse",
		});
		harness.setResponses([
			failRead,
			failRead,
			failRead,
			failRead,
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("wrote it"),
			// Extra fix turn enabled by guided (+1 maxAttempts â†’ 2 total fixes).
			fauxAssistantMessage("attempted another fix"),
			fauxAssistantMessage("honest summary"),
		]);

		await harness.session.prompt("create out.txt");

		expect(harness.session.getRecoveryLevel()).not.toBe("lean");
		const failed = harness.eventsOfType("verification").filter((e) => e.phase === "failed");
		const maxReported = Math.max(...failed.map((e) => e.maxAttempts));
		expect(maxReported).toBe(2);
		const userTexts = getUserTexts(harness);
		expect(userTexts.some((t) => t.includes("isn't verified yet"))).toBe(true);
		expect(userTexts.some((t) => t.includes(TERMINAL_MARKER))).toBe(true);
	});
});
