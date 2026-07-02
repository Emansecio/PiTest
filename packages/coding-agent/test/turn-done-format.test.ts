import type { AgentMessage } from "@pit/agent-core";
import { describe, expect, it } from "vitest";
import { buildTurnDoneSnapshot, formatTurnDoneDisplayLine } from "../src/modes/interactive/turn-done-format.js";

describe("turn-done-format", () => {
	it("formatTurnDoneDisplayLine shows success stats", () => {
		const line = formatTurnDoneDisplayLine({
			elapsedMs: 12_000,
			inputTokens: 1200,
			outputTokens: 340,
			cost: 0.0042,
			stopReason: "stop",
			contextPercent: 18,
		});
		expect(line).toContain("12s");
		expect(line).toContain("↑1.2k");
		expect(line).toContain("↓340");
		expect(line).toContain("$0.004");
		expect(line).toContain("ctx 18%");
	});

	it("formatTurnDoneDisplayLine shows aborted and error outcomes", () => {
		expect(
			formatTurnDoneDisplayLine({
				elapsedMs: 8000,
				inputTokens: 0,
				outputTokens: 0,
				stopReason: "aborted",
			}),
		).toBe("8s · aborted");
		expect(
			formatTurnDoneDisplayLine({
				elapsedMs: 8000,
				inputTokens: 0,
				outputTokens: 0,
				stopReason: "error",
			}),
		).toBe("8s · error");
	});

	it("buildTurnDoneSnapshot sums assistant usage for the run", () => {
		const snapshot = buildTurnDoneSnapshot(
			[
				{
					role: "assistant",
					content: [{ type: "text", text: "a" }],
					usage: {
						input: 100,
						output: 50,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 150,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
					},
					stopReason: "toolUse",
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "b" }],
					usage: {
						input: 200,
						output: 80,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 280,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 },
					},
					stopReason: "stop",
				},
			] as AgentMessage[],
			5000,
			{ percent: 12, estimated: true },
		);
		expect(snapshot.inputTokens).toBe(300);
		expect(snapshot.outputTokens).toBe(130);
		expect(snapshot.cost).toBeCloseTo(0.003);
		expect(snapshot.stopReason).toBe("stop");
		expect(snapshot.estimated).toBe(true);
	});
});
