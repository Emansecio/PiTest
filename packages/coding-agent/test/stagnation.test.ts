import { type AssistantMessage, getModel, type ToolResultMessage } from "@pit/ai";
import { describe, expect, it } from "vitest";
import {
	buildStagnationReminder,
	classifyTurn,
	decideStagnationReminder,
	MUTATING_TOOL_NAMES,
	StagnationTracker,
} from "../src/core/stagnation.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function assistantWithToolCalls(calls: Array<{ id: string; name: string }>): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: {} })),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function textOnlyAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function result(toolCallId: string, isError: boolean): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "x",
		content: [{ type: "text", text: isError ? "boom" : "ok" }],
		isError,
		timestamp: 0,
	};
}

describe("MUTATING_TOOL_NAMES", () => {
	it("contains exactly the file-mutation tools", () => {
		expect([...MUTATING_TOOL_NAMES].sort()).toEqual(["ast_edit", "edit", "edit_v2", "write"]);
	});
});

describe("classifyTurn", () => {
	it("returns text-only when there are no tool calls", () => {
		expect(classifyTurn(textOnlyAssistant("done"), [])).toBe("text-only");
	});

	it("returns nonproductive when tool calls are all read-only", () => {
		const msg = assistantWithToolCalls([
			{ id: "a", name: "read" },
			{ id: "b", name: "grep" },
		]);
		expect(classifyTurn(msg, [result("a", false), result("b", false)])).toBe("nonproductive");
	});

	it("treats bash as non-productive (shelling out is not progress)", () => {
		const msg = assistantWithToolCalls([{ id: "a", name: "bash" }]);
		expect(classifyTurn(msg, [result("a", false)])).toBe("nonproductive");
	});

	it("returns productive when a mutating call succeeded", () => {
		const msg = assistantWithToolCalls([
			{ id: "a", name: "read" },
			{ id: "b", name: "edit" },
		]);
		expect(classifyTurn(msg, [result("a", false), result("b", false)])).toBe("productive");
	});

	it("returns nonproductive when the only mutating call errored", () => {
		const msg = assistantWithToolCalls([{ id: "a", name: "edit" }]);
		expect(classifyTurn(msg, [result("a", true)])).toBe("nonproductive");
	});

	it("treats a mutating call with no matching result as productive (lean against false positives)", () => {
		const msg = assistantWithToolCalls([{ id: "a", name: "write" }]);
		expect(classifyTurn(msg, [])).toBe("productive");
	});
});

describe("StagnationTracker", () => {
	it("increments on nonproductive turns and resets on productive/text-only", () => {
		const t = new StagnationTracker();
		expect(t.observe("nonproductive")).toBe(1);
		expect(t.observe("nonproductive")).toBe(2);
		expect(t.observe("productive")).toBe(0);
		expect(t.observe("nonproductive")).toBe(1);
		expect(t.observe("text-only")).toBe(0);
		expect(t.nonProductiveTurns).toBe(0);
	});

	it("reset() zeroes the streak", () => {
		const t = new StagnationTracker();
		t.observe("nonproductive");
		t.observe("nonproductive");
		t.reset();
		expect(t.nonProductiveTurns).toBe(0);
	});
});

describe("decideStagnationReminder", () => {
	const base = {
		enabled: true,
		softThreshold: 12,
		hardThreshold: 25,
		lastFiredAt: 0,
		now: 100_000,
		cooldownMs: 30_000,
	};

	it("does nothing when disabled", () => {
		expect(decideStagnationReminder({ ...base, enabled: false, count: 99 }).action).toBe("none");
	});

	it("does nothing below the soft threshold", () => {
		expect(decideStagnationReminder({ ...base, count: 11 }).action).toBe("none");
	});

	it("reminds at the soft threshold and records the fire time", () => {
		const out = decideStagnationReminder({ ...base, count: 12 });
		expect(out.action).toBe("remind");
		expect(out.nextLastFiredAt).toBe(100_000);
	});

	it("suppresses a second soft reminder inside the cooldown", () => {
		const out = decideStagnationReminder({ ...base, count: 13, lastFiredAt: 95_000, now: 100_000 });
		expect(out.action).toBe("none");
		expect(out.nextLastFiredAt).toBe(95_000);
	});

	it("re-reminds once the cooldown has elapsed", () => {
		const out = decideStagnationReminder({ ...base, count: 13, lastFiredAt: 70_000, now: 100_000 });
		expect(out.action).toBe("remind");
		expect(out.nextLastFiredAt).toBe(100_000);
	});

	it("pauses at the hard threshold regardless of cooldown", () => {
		const out = decideStagnationReminder({ ...base, count: 25, lastFiredAt: 99_999, now: 100_000 });
		expect(out.action).toBe("pause");
		expect(out.nextLastFiredAt).toBe(100_000);
	});
});

describe("buildStagnationReminder", () => {
	it("builds the soft reminder", () => {
		const out = buildStagnationReminder({ count: 12, paused: false });
		expect(out).toContain("<stagnation-reminder>");
		expect(out).toContain("12 consecutive turns");
		expect(out).toContain("make the edit now");
		expect(out).not.toContain("paused execution");
		expect(out).toContain("</stagnation-reminder>");
	});

	it("builds the pause variant", () => {
		const out = buildStagnationReminder({ count: 25, paused: true });
		expect(out).toContain("paused execution");
		expect(out).toContain("25 non-productive turns");
	});
});

describe("integration: realistic sequence", () => {
	it("reminds at 12, gates within cooldown, pauses at hard ceiling, edit resets", () => {
		const t = new StagnationTracker();
		const cfg = { enabled: true, softThreshold: 12, hardThreshold: 25, cooldownMs: 30_000 };
		let lastFiredAt = 0;
		const actions: string[] = [];
		for (let i = 1; i <= 12; i++) {
			const count = t.observe("nonproductive");
			const d = decideStagnationReminder({ ...cfg, count, lastFiredAt, now: i * 1000 });
			lastFiredAt = d.nextLastFiredAt;
			actions.push(d.action);
		}
		expect(actions[11]).toBe("remind");
		expect(actions.slice(0, 11).every((a) => a === "none")).toBe(true);

		const afterEdit = t.observe("productive");
		expect(afterEdit).toBe(0);
		expect(decideStagnationReminder({ ...cfg, count: afterEdit, lastFiredAt, now: 13_000 }).action).toBe("none");
	});
});
