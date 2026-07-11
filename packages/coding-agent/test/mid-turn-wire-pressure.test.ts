import type { AgentMessage } from "@pit/agent-core";
import { describe, expect, it, vi } from "vitest";
import {
	applyMidTurnPressureRelief,
	measureMidTurnWirePressure,
	parseMidTurnPressureRatio,
} from "../src/core/agent-session-compaction.js";

describe("mid-turn wire pressure", () => {
	it("parses ratio with clamp and default", () => {
		expect(parseMidTurnPressureRatio(undefined)).toBe(0.92);
		expect(parseMidTurnPressureRatio("0.85")).toBe(0.85);
		expect(parseMidTurnPressureRatio("0.1")).toBe(0.5);
		expect(parseMidTurnPressureRatio("1.5")).toBe(0.99);
		expect(parseMidTurnPressureRatio("nope")).toBe(0.92);
	});

	it("does not trip when kill-switch is set", () => {
		vi.stubEnv("PIT_NO_MID_TURN_PRESSURE_GUARD", "1");
		const model = { contextWindow: 100_000 } as any;
		const result = measureMidTurnWirePressure([], model, {
			systemPrompt: "x".repeat(50_000),
			tools: [],
			thinkingLevel: "off",
			ratio: 0.5,
		});
		expect(result.tripped).toBe(false);
		vi.unstubAllEnvs();
	});

	it("applyMidTurnPressureRelief is a no-op on empty messages", () => {
		const messages: AgentMessage[] = [];
		const out = applyMidTurnPressureRelief(messages, 200_000);
		expect(out.reclaimed).toBe(0);
		expect(out.messages).toBe(messages);
	});

	it("early-exits as not tripped when far below the ratio threshold", () => {
		const model = { contextWindow: 200_000 } as any;
		const result = measureMidTurnWirePressure([], model, {
			systemPrompt: "short",
			tools: [],
			thinkingLevel: "off",
			ratio: 0.92,
		});
		expect(result.tripped).toBe(false);
		expect(result.pressure).toBeLessThan(200_000 * 0.92);
	});

	it("trips when unanchored wire estimate exceeds a low ratio", () => {
		const model = { contextWindow: 1_000 } as any;
		const result = measureMidTurnWirePressure([], model, {
			systemPrompt: "x".repeat(20_000),
			tools: [],
			thinkingLevel: "off",
			ratio: 0.5,
		});
		expect(result.tripped).toBe(true);
		expect(result.assembled).toBeGreaterThan(500);
	});
});
