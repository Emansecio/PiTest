/**
 * Integration test for autonomous goal auto-continuation: after the agent ends
 * a turn without calling goal_complete, the session should drive a continuation
 * turn on its own, and stop once goal_complete fires.
 */
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	_registerBashBackgroundJobForTest,
	_resetBashBackgroundJobsForTest,
	type BashBackgroundJob,
} from "../src/core/tools/bash.js";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.js";

function goalCompleteInput(harness: Harness, summary: string) {
	const contract = harness.session.goalSnapshot()?.contract;
	if (!contract) throw new Error("active Goal contract required by faux response");
	return {
		summary,
		contractRevision: contract.revision,
		criteria: contract.criteria.map((criterion) => ({
			id: criterion.id,
			outcome: `${criterion.text} completed`,
			evidence: [{ kind: "claim", note: "verified by the integration test fixture" }],
		})),
	};
}

function bgJob(over: Partial<BashBackgroundJob>): BashBackgroundJob {
	return {
		id: "foreign-bg",
		ownerSessionId: "foreign-session",
		pid: 1,
		command: "npm run check",
		startedAt: 0,
		promotedAt: 0,
		exited: false,
		exitCode: null,
		lastOutputAt: 0,
		resultSeen: false,
		ringBuffer: "",
		ringTruncated: false,
		kill: () => {},
		...over,
	};
}

describe("goal auto-continuation", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		_resetBashBackgroundJobsForTest();
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("continues after an incomplete turn and stops when goal_complete is called", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.startGoal("finish the task", {});
		expect(harness.session.getActiveToolNames()).toContain("goal_complete");

		harness.setResponses([
			// Turn from the initial objective prompt — no goal_complete yet.
			fauxAssistantMessage("did step one"),
			// Auto-continuation turn — the agent now calls goal_complete.
			fauxAssistantMessage([fauxToolCall("goal_complete", goalCompleteInput(harness, "all done"))], {
				stopReason: "toolUse",
			}),
			// Wrap-up after the tool result.
			fauxAssistantMessage("finished"),
		]);

		await harness.session.prompt("finish the task");

		expect(harness.session.goalSnapshot()?.status).toBe("complete");
		// The continuation prompt was injected as a second user message.
		const userTexts = getUserTexts(harness);
		expect(userTexts.length).toBeGreaterThanOrEqual(2);
		expect(userTexts.some((t) => t.toLowerCase().includes("continue working toward the goal"))).toBe(true);
		// goal_complete is removed from the surface once cleared.
		harness.session.clearGoal();
		expect(harness.session.getActiveToolNames()).not.toContain("goal_complete");
	});

	it("persists goal progress to the session so it survives a reload", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.startGoal("persist me", {});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("goal_complete", goalCompleteInput(harness, "ok"))], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("persist me");

		const goalEntries = harness.sessionManager
			.getEntries()
			.filter((e) => (e as { type?: string; customType?: string }).customType === "goal");
		expect(goalEntries.length).toBeGreaterThan(0);
		const last = goalEntries[goalEntries.length - 1] as {
			data?: {
				status?: string;
				iterations?: number;
				tokensUsed?: number;
				activeElapsedMs?: number;
				receipt?: { usage: { iterations: number; tokens: number; activeMs: number } };
			};
		};
		expect(last.data?.status).toBe("complete");
		expect(last.data?.iterations ?? 0).toBeGreaterThanOrEqual(1);
		expect(last.data?.receipt?.usage).toEqual({
			iterations: last.data?.iterations,
			tokens: last.data?.tokensUsed,
			activeMs: last.data?.activeElapsedMs,
		});
	});

	it("restores a completed Goal and receipt without auto-continuing or exposing goal_complete", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.startGoal("persist the completed receipt", {});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("goal_complete", goalCompleteInput(harness, "persisted"))], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("persist the completed receipt");
		const completed = harness.session.goalSnapshot();
		expect(completed).toMatchObject({ status: "complete", receipt: { objective: "persist the completed receipt" } });

		harness.session.clearGoal();
		harness.sessionManager.appendCustomEntry("goal", completed);
		const restore = harness.session as unknown as { _restoreStateFromSession(): void };
		restore._restoreStateFromSession();

		expect(harness.session.goalSnapshot()).toMatchObject({
			status: "complete",
			receipt: { objective: "persist the completed receipt" },
		});
		const restored = harness.session.goalSnapshot();
		expect(restored?.receipt?.usage).toEqual({
			iterations: restored?.iterations,
			tokens: restored?.tokensUsed,
			activeMs: restored?.activeElapsedMs,
		});
		expect(harness.session.goalShouldAutoContinue()).toBe(false);
		expect(harness.session.getActiveToolNames()).not.toContain("goal_complete");
	});

	it("ignores a foreign-session pending check through the AgentSession-built goal_complete", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.startGoal("ship this session", {});
		_registerBashBackgroundJobForTest(bgJob({}));
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("goal_complete", goalCompleteInput(harness, "done"))], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("finished"),
		]);

		await harness.session.prompt("ship this session");

		expect(harness.session.goalSnapshot()?.status).toBe("complete");
	});

	it("does not auto-continue when no goal is active", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("just one turn")]);
		await harness.session.prompt("hello");

		expect(getUserTexts(harness)).toEqual(["hello"]);
		expect(harness.session.goalSnapshot()).toBeUndefined();
	});
});
