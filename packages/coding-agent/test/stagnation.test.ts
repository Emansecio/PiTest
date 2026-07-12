import { type AssistantMessage, getModel, type ToolResultMessage } from "@pit/ai";
import { describe, expect, it } from "vitest";
import {
	buildStagnationReminder,
	classifyTurn,
	decideStagnationReminder,
	MUTATING_TOOL_NAMES,
	StagnationTracker,
} from "../src/core/stagnation.js";

const model = getModel("anthropic", "claude-sonnet-5")!;

function assistantWithToolCalls(
	calls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>,
): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.arguments ?? {} })),
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

	it("treats a plain (non-verification) bash as non-productive", () => {
		const msg = assistantWithToolCalls([{ id: "a", name: "bash", arguments: { command: "git status" } }]);
		expect(classifyTurn(msg, [result("a", false)])).toBe("nonproductive");
	});

	it("treats a verification bash (tests/build/lint) as neutral", () => {
		for (const command of ["npm run check", "npx vitest --run test/x.test.ts", "cargo build", "pytest -q"]) {
			const msg = assistantWithToolCalls([{ id: "a", name: "bash", arguments: { command } }]);
			expect(classifyTurn(msg, [result("a", false)])).toBe("neutral");
		}
	});

	it("keeps an errored verification bash non-productive", () => {
		const msg = assistantWithToolCalls([{ id: "a", name: "bash", arguments: { command: "npm run check" } }]);
		expect(classifyTurn(msg, [result("a", true)])).toBe("nonproductive");
	});

	it("does not match verification keywords inside other words (checkout, makefile)", () => {
		const msg = assistantWithToolCalls([{ id: "a", name: "bash", arguments: { command: "git checkout main" } }]);
		expect(classifyTurn(msg, [result("a", false)])).toBe("nonproductive");
	});

	it("treats a successful task delegation as productive", () => {
		const msg = assistantWithToolCalls([{ id: "a", name: "task" }]);
		expect(classifyTurn(msg, [result("a", false)])).toBe("productive");
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

	it("leaves the streak unchanged on a neutral (verification) turn", () => {
		const t = new StagnationTracker();
		expect(t.observe("nonproductive")).toBe(1);
		expect(t.observe("nonproductive")).toBe(2);
		expect(t.observe("neutral")).toBe(2);
		expect(t.observe("neutral")).toBe(2);
		expect(t.observe("nonproductive")).toBe(3);
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

	it("records the fired streak length on the first soft reminder", () => {
		const out = decideStagnationReminder({ ...base, count: 12 });
		expect(out.action).toBe("remind");
		expect(out.nextLastFiredCount).toBe(12);
	});

	it("suppresses a repeat soft reminder when the streak has not grown by `step` (cooldown elapsed)", () => {
		// step = ceil((25-12)/2) = 7. Fired at 12, streak crept to 14 (< 12+7): even
		// though the cooldown is long elapsed, the identical reminder is NOT re-injected.
		const out = decideStagnationReminder({
			...base,
			count: 14,
			lastFiredAt: 60_000,
			now: 100_000,
			lastFiredCount: 12,
		});
		expect(out.action).toBe("none");
		expect(out.nextLastFiredAt).toBe(60_000);
		expect(out.nextLastFiredCount).toBe(12);
	});

	it("re-reminds once the streak grows by `step` AND the cooldown elapsed", () => {
		// Fired at 12, streak now 19 (= 12 + step). Both gates open → remind, and the
		// new fired-count is recorded so the next gate moves to 26.
		const out = decideStagnationReminder({
			...base,
			count: 19,
			lastFiredAt: 60_000,
			now: 100_000,
			lastFiredCount: 12,
		});
		expect(out.action).toBe("remind");
		expect(out.nextLastFiredCount).toBe(19);
	});

	it("still gates on cooldown even when the streak grew past `step`", () => {
		// Streak grew enough (12 → 20) but the cooldown floor has NOT elapsed.
		const out = decideStagnationReminder({
			...base,
			count: 20,
			lastFiredAt: 95_000,
			now: 100_000,
			lastFiredCount: 12,
		});
		expect(out.action).toBe("none");
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
