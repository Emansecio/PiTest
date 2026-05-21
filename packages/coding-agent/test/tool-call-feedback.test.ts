import { describe, expect, it } from "vitest";
import {
	buildDoomLoopReminder,
	buildToolErrorReflection,
	decideDoomLoopReminder,
	decideErrorReflection,
} from "../src/core/tool-call-feedback.js";

describe("buildToolErrorReflection", () => {
	it("includes tool name, args, error, and the 3 structured questions", () => {
		const out = buildToolErrorReflection({
			toolName: "edit",
			args: { path: "src/a.ts", old: "x", new: "y" },
			errorMessage: "no match for old_string",
		});

		expect(out).toContain("<tool-error-reflection>");
		expect(out).toContain("`edit`");
		expect(out).toContain('"path": "src/a.ts"');
		expect(out).toContain("no match for old_string");
		expect(out).toMatch(/1\. \*\*What was wrong\*\*/);
		expect(out).toMatch(/2\. \*\*Why\*\*/);
		expect(out).toMatch(/3\. \*\*What is the corrected approach\*\*/);
		expect(out).toContain("</tool-error-reflection>");
	});

	it("surfaces attemptsLeft when provided", () => {
		const out = buildToolErrorReflection({
			toolName: "bash",
			errorMessage: "exit 1",
			attemptsLeft: 2,
		});
		expect(out).toContain("Retries remaining for this tool: 2");
	});

	it("clamps negative attemptsLeft to 0", () => {
		const out = buildToolErrorReflection({
			toolName: "bash",
			errorMessage: "boom",
			attemptsLeft: -3,
		});
		expect(out).toContain("Retries remaining for this tool: 0");
	});

	it("omits args block when args are absent or null", () => {
		const out = buildToolErrorReflection({ toolName: "read", errorMessage: "nope" });
		expect(out).not.toContain("Arguments:");
		const out2 = buildToolErrorReflection({ toolName: "read", args: null, errorMessage: "nope" });
		expect(out2).not.toContain("Arguments:");
	});

	it("omits error block when errorMessage is empty/whitespace", () => {
		const out = buildToolErrorReflection({ toolName: "read", args: { path: "x" }, errorMessage: "   \n" });
		expect(out).not.toContain("Error:");
	});

	it("truncates very long args payloads", () => {
		const out = buildToolErrorReflection({
			toolName: "write",
			args: { content: "x".repeat(2000) },
		});
		expect(out).toContain("truncated");
		expect(out.length).toBeLessThan(2000);
	});

	it("survives circular args via stringify fallback", () => {
		const a: Record<string, unknown> = { name: "root" };
		a.self = a;
		expect(() => buildToolErrorReflection({ toolName: "x", args: a, errorMessage: "e" })).not.toThrow();
	});
});

describe("buildDoomLoopReminder", () => {
	it("names the tool and reports the consecutive count", () => {
		const out = buildDoomLoopReminder({
			toolName: "grep",
			args: { pattern: "foo", path: "src" },
			consecutiveCount: 5,
		});
		expect(out).toContain("<doom-loop-reminder>");
		expect(out).toContain("`grep`");
		expect(out).toContain("5 consecutive");
		expect(out).toContain('"pattern": "foo"');
		expect(out).toContain("Do not repeat the same call");
		expect(out).toContain("</doom-loop-reminder>");
	});

	it("clamps negative counts to 0", () => {
		const out = buildDoomLoopReminder({ toolName: "x", consecutiveCount: -1 });
		expect(out).toContain("0 consecutive");
	});

	it("works without args", () => {
		const out = buildDoomLoopReminder({ toolName: "x", consecutiveCount: 3 });
		expect(out).not.toContain("Repeated arguments:");
	});

	it("floors fractional counts", () => {
		const out = buildDoomLoopReminder({ toolName: "x", consecutiveCount: 3.9 });
		expect(out).toContain("3 consecutive");
	});
});

describe("decideDoomLoopReminder", () => {
	const base = { threshold: 3, cooldownMs: 1000, consecutiveCount: 0, lastFiredAt: 0, now: 5000 };

	it("does not fire when disabled", () => {
		const r = decideDoomLoopReminder({ ...base, enabled: false, consecutiveCount: 100 });
		expect(r.fire).toBe(false);
		expect(r.nextLastFiredAt).toBe(0);
	});

	it("does not fire below threshold", () => {
		const r = decideDoomLoopReminder({ ...base, enabled: true, consecutiveCount: 2 });
		expect(r.fire).toBe(false);
	});

	it("fires at or above threshold when cooldown has elapsed", () => {
		const r = decideDoomLoopReminder({ ...base, enabled: true, consecutiveCount: 3, now: 5000, lastFiredAt: 0 });
		expect(r.fire).toBe(true);
		expect(r.nextLastFiredAt).toBe(5000);
	});

	it("respects cooldown window", () => {
		const r = decideDoomLoopReminder({
			...base,
			enabled: true,
			consecutiveCount: 5,
			lastFiredAt: 4500,
			now: 5000,
			cooldownMs: 1000,
		});
		expect(r.fire).toBe(false);
		expect(r.nextLastFiredAt).toBe(4500);
	});

	it("fires again once cooldown has fully elapsed (inclusive boundary)", () => {
		const r = decideDoomLoopReminder({
			...base,
			enabled: true,
			consecutiveCount: 5,
			lastFiredAt: 4000,
			now: 5000,
			cooldownMs: 1000,
		});
		expect(r.fire).toBe(true);
	});
});

describe("decideErrorReflection", () => {
	it("does not fire when disabled", () => {
		expect(decideErrorReflection({ enabled: false, isError: true })).toBe(false);
	});

	it("does not fire on success", () => {
		expect(decideErrorReflection({ enabled: true, isError: false })).toBe(false);
	});

	it("fires when enabled and the tool returned an error", () => {
		expect(decideErrorReflection({ enabled: true, isError: true })).toBe(true);
	});
});
