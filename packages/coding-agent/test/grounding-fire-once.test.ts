import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { beforeEach, describe, expect, it } from "vitest";
import { createGuard, type GuardSpec, stableToolCallKey } from "../src/core/built-ins/grounding-fire-once.ts";
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "../src/core/extensions/types.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

/** Minimal ExtensionAPI shim: collects the tool_call handler and replays it. */
function register(spec: GuardSpec): (event: ToolCallEvent, ctx?: unknown) => unknown {
	let captured: Handler | undefined;
	const api = {
		on(event: string, handler: Handler) {
			if (event === "tool_call") captured = handler;
		},
	} as unknown as ExtensionAPI;
	createGuard(spec)(api);
	if (!captured) throw new Error("guard registered no tool_call handler");
	const handler = captured;
	return (event, ctx) => handler(event, ctx);
}

const call = (input: Record<string, unknown>, toolCallId = "c1", toolName = "grep"): ToolCallEvent =>
	({ type: "tool_call", toolName, toolCallId, input }) as ToolCallEvent;

const baseSpec = (overrides: Partial<GuardSpec> = {}): GuardSpec => ({
	category: "guard.pattern-grounding",
	source: "test-guard",
	ruleId: "test-rule",
	appliesTo: () => true,
	decide: () => undefined,
	...overrides,
});

const patternEvents = () => getRuntimeDiagnostics().recent.filter((e) => e.category === "guard.pattern-grounding");

const failureEvents = () => getRuntimeDiagnostics().recent.filter((e) => e.category === "guard.failed");

describe("stableToolCallKey", () => {
	it("is stable across a re-ordering of the top-level arg keys", () => {
		expect(stableToolCallKey("grep", { a: 1, b: 2 })).toBe(stableToolCallKey("grep", { b: 2, a: 1 }));
	});

	it("separates different tools and different values", () => {
		expect(stableToolCallKey("grep", { a: 1 })).not.toBe(stableToolCallKey("find", { a: 1 }));
		expect(stableToolCallKey("grep", { a: 1 })).not.toBe(stableToolCallKey("grep", { a: 2 }));
	});
});

describe("createGuard — decisions", () => {
	beforeEach(() => {
		resetRuntimeDiagnostics();
	});

	it("allows when decide returns undefined (no diagnostic)", () => {
		const fire = register(baseSpec());
		expect(fire(call({ pattern: "x" }))).toBeUndefined();
		expect(patternEvents()).toHaveLength(0);
	});

	it("allows on an explicit {action:'allow'} (no diagnostic)", () => {
		const fire = register(baseSpec({ decide: () => ({ action: "allow" }) }));
		expect(fire(call({ pattern: "x" }))).toBeUndefined();
		expect(patternEvents()).toHaveLength(0);
	});

	it("blocks with the decision's reason and records outcome:blocked", () => {
		const fire = register(baseSpec({ decide: () => ({ action: "block", reason: "nope" }) }));
		expect(fire(call({ pattern: "x" }))).toEqual({ block: true, reason: "nope" });

		const events = patternEvents();
		expect(events).toHaveLength(1);
		expect(events[0]?.source).toBe("test-guard");
		expect(events[0]?.level).toBe("info");
		expect(events[0]?.context).toEqual({
			note: "grep",
			outcome: "blocked",
			ruleId: "test-rule",
			toolName: "grep",
			toolCallId: "c1",
		});
	});

	it("rewrites the args IN PLACE, passes, and records without an outcome", () => {
		const fire = register(baseSpec({ decide: () => ({ action: "rewrite", args: { pattern: "fixed" } }) }));
		const input = { pattern: "typo", extra: 1 };
		expect(fire(call(input))).toBeUndefined();
		// Mutated in place — later handlers and the tool itself see the correction.
		expect(input).toEqual({ pattern: "fixed", extra: 1 });

		const events = patternEvents();
		expect(events).toHaveLength(1);
		// The outcome enum ("blocked"|"overridden") cannot express an auto-correct.
		expect(events[0]?.context).toEqual({ note: "grep", ruleId: "test-rule" });
	});

	it("lets a decision override the spec-level ruleId and note", () => {
		const fire = register(
			baseSpec({ decide: () => ({ action: "block", reason: "nope", ruleId: "sub-kind", note: "kind:grep" }) }),
		);
		fire(call({ pattern: "x" }));
		expect(patternEvents()[0]?.context).toMatchObject({ ruleId: "sub-kind", note: "kind:grep" });
	});
});

describe("createGuard — fire-once escape", () => {
	beforeEach(() => {
		resetRuntimeDiagnostics();
	});

	it("blocks once, then lets the IDENTICAL re-issue run (outcome:overridden)", () => {
		const fire = register(baseSpec({ decide: () => ({ action: "block", reason: "nope" }) }));
		expect(fire(call({ pattern: "x" }))?.valueOf()).toEqual({ block: true, reason: "nope" });
		expect(fire(call({ pattern: "x" }, "c2"))).toBeUndefined();

		expect(patternEvents().map((e) => e.context?.outcome)).toEqual(["blocked", "overridden"]);
		// The override diagnostic carries the RE-ISSUE's tool call id.
		expect(patternEvents()[1]?.context?.toolCallId).toBe("c2");
	});

	it("matches the fire-once key across a re-ordering of the arg keys", () => {
		const fire = register(baseSpec({ decide: () => ({ action: "block", reason: "nope" }) }));
		expect(fire(call({ pattern: "x", glob: "*.ts" }))).toEqual({ block: true, reason: "nope" });
		// Same call, keys emitted in the other order -> still the fire-once escape.
		expect(fire(call({ glob: "*.ts", pattern: "x" }, "c2"))).toBeUndefined();
		expect(patternEvents().map((e) => e.context?.outcome)).toEqual(["blocked", "overridden"]);
	});

	it("blocks a DIFFERENT call again (the escape is per (tool, args))", () => {
		const fire = register(baseSpec({ decide: () => ({ action: "block", reason: "nope" }) }));
		expect(fire(call({ pattern: "x" }))).toEqual({ block: true, reason: "nope" });
		expect(fire(call({ pattern: "y" }, "c2"))).toEqual({ block: true, reason: "nope" });
		expect(patternEvents().map((e) => e.context?.outcome)).toEqual(["blocked", "blocked"]);
	});

	it("keeps the escape per guard INSTANCE (a fresh registration blocks again)", () => {
		const spec = baseSpec({ decide: () => ({ action: "block", reason: "nope" }) });
		const first = register(spec);
		expect(first(call({ pattern: "x" }))).toEqual({ block: true, reason: "nope" });
		const second = register(spec);
		expect(second(call({ pattern: "x" }))).toEqual({ block: true, reason: "nope" });
	});
});

describe("createGuard — gates", () => {
	beforeEach(() => {
		resetRuntimeDiagnostics();
	});

	it("skips tools the guard does not apply to (decide never runs)", () => {
		let calls = 0;
		const fire = register(
			baseSpec({
				appliesTo: (toolName) => toolName === "grep",
				decide: () => {
					calls += 1;
					return { action: "block", reason: "nope" };
				},
			}),
		);
		expect(fire(call({ pattern: "x" }, "c1", "read"))).toBeUndefined();
		expect(calls).toBe(0);
		expect(fire(call({ pattern: "x" }, "c1", "grep"))).toEqual({ block: true, reason: "nope" });
		expect(calls).toBe(1);
	});

	it("honours the kill-switch per call (decide never runs, no diagnostic)", () => {
		let off = true;
		let calls = 0;
		const fire = register(
			baseSpec({
				disabled: () => off,
				decide: () => {
					calls += 1;
					return { action: "block", reason: "nope" };
				},
			}),
		);
		expect(fire(call({ pattern: "x" }))).toBeUndefined();
		expect(calls).toBe(0);
		expect(patternEvents()).toHaveLength(0);

		// Evaluated per call: flipping it mid-session takes effect immediately.
		off = false;
		expect(fire(call({ pattern: "x" }))).toEqual({ block: true, reason: "nope" });
	});

	it("fails OPEN when the kill-switch itself throws", () => {
		const fire = register(
			baseSpec({
				disabled: () => {
					throw new Error("boom");
				},
				decide: () => ({ action: "block", reason: "nope" }),
			}),
		);
		expect(fire(call({ pattern: "x" }))).toBeUndefined();
	});

	it("fails OPEN when appliesTo throws", () => {
		const fire = register(
			baseSpec({
				appliesTo: () => {
					throw new Error("boom");
				},
				decide: () => ({ action: "block", reason: "nope" }),
			}),
		);
		expect(fire(call({ pattern: "x" }))).toBeUndefined();
	});
});

describe("createGuard — fail-open", () => {
	beforeEach(() => {
		resetRuntimeDiagnostics();
	});

	it("fails OPEN when a SYNC decide throws, and RECORDS the contained fault", () => {
		const fire = register(
			baseSpec({
				decide: () => {
					throw new Error("boom");
				},
			}),
		);
		expect(fire(call({ pattern: "x" }))).toBeUndefined();
		// The guard's own channel stays clean — a fault is not a verdict.
		expect(patternEvents()).toHaveLength(0);
		// ...but the hole is visible: this call ran UNVETTED.
		const failures = failureEvents();
		expect(failures).toHaveLength(1);
		expect(failures[0]?.level).toBe("error");
		expect(failures[0]?.source).toBe("test-guard");
		expect(failures[0]?.context).toMatchObject({
			outcome: "failed",
			ruleId: "test-rule",
			phase: "check",
			toolName: "grep",
			toolCallId: "c1",
			note: "boom",
		});
	});

	it("fails OPEN when an ASYNC decide rejects, and RECORDS the contained fault", async () => {
		const fire = register(baseSpec({ decide: async () => Promise.reject(new Error("boom")) }));
		await expect(fire(call({ pattern: "x" }))).resolves.toBeUndefined();
		expect(patternEvents()).toHaveLength(0);
		expect(failureEvents()[0]?.context).toMatchObject({ phase: "check", note: "boom" });
	});

	it("records phase:'settle' when the failure happens AFTER the decision", () => {
		// A frozen `input` makes the in-place rewrite throw inside settle().
		const fire = register(baseSpec({ decide: () => ({ action: "rewrite", args: { pattern: "fixed" } }) }));
		const event = call(Object.freeze({ pattern: "typo" }) as Record<string, unknown>);
		expect(fire(event)).toBeUndefined();
		expect(failureEvents()[0]?.context).toMatchObject({ phase: "settle" });
	});

	it("records a fault raised by the kill-switch and by the tool gate", () => {
		const killSwitch = register(
			baseSpec({
				disabled: () => {
					throw new Error("switch boom");
				},
			}),
		);
		expect(killSwitch(call({ pattern: "x" }))).toBeUndefined();
		const gate = register(
			baseSpec({
				appliesTo: () => {
					throw new Error("gate boom");
				},
			}),
		);
		expect(gate(call({ pattern: "x" }))).toBeUndefined();
		expect(failureEvents().map((e) => e.context?.note)).toEqual(["switch boom", "gate boom"]);
	});
});

describe("createGuard — sync/async shape", () => {
	beforeEach(() => {
		resetRuntimeDiagnostics();
	});

	it("returns the verdict SYNCHRONOUSLY when decide is synchronous", () => {
		const fire = register(baseSpec({ decide: () => ({ action: "block", reason: "nope" }) }));
		const result = fire(call({ pattern: "x" }));
		// Callers of the sync guards read the verdict without awaiting.
		expect(result).not.toBeInstanceOf(Promise);
		expect((result as ToolCallEventResult).block).toBe(true);
	});

	it("awaits an async decide and applies the same ritual", async () => {
		const fire = register(baseSpec({ decide: async () => ({ action: "block", reason: "nope" }) }));
		await expect(fire(call({ pattern: "x" }))).resolves.toEqual({ block: true, reason: "nope" });
		await expect(fire(call({ pattern: "x" }, "c2"))).resolves.toBeUndefined();
		expect(patternEvents().map((e) => e.context?.outcome)).toEqual(["blocked", "overridden"]);
	});

	it("passes the extension ctx through to decide (undefined on the subagent shim)", async () => {
		const seen: unknown[] = [];
		const fire = register(
			baseSpec({
				decide: (_event, ctx) => {
					seen.push(ctx);
					return undefined;
				},
			}),
		);
		const ctx = { signal: undefined };
		fire(call({ pattern: "x" }), ctx);
		fire(call({ pattern: "x" }));
		expect(seen).toEqual([ctx, undefined]);
	});
});
