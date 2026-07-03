import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { createPatchAuditExtension } from "../src/core/built-ins/patch-audit-extension.ts";
import type { ExtensionAPI, ToolResultEvent, ToolResultEventResult } from "../src/core/extensions/types.ts";
import { auditPatchResult, isPatchAuditDisabled } from "../src/core/patch-audit.ts";
import { TurnRiskAccumulator } from "../src/core/turn-risk.ts";

type ToolResultHandler = (event: ToolResultEvent) => ToolResultEventResult | undefined;

function makeFakePi() {
	const handlers: ToolResultHandler[] = [];
	const api = {
		on(event: string, handler: ToolResultHandler) {
			if (event === "tool_result") handlers.push(handler);
		},
	} as unknown as ExtensionAPI;
	const fire = (event: ToolResultEvent): ToolResultEventResult | undefined => {
		let result: ToolResultEventResult | undefined;
		let current = event;
		for (const handler of handlers) {
			const handlerResult = handler(current);
			if (!handlerResult) continue;
			result = handlerResult;
			current = {
				...current,
				content: handlerResult.content ?? current.content,
				details: handlerResult.details ?? current.details,
				isError: handlerResult.isError ?? current.isError,
			} as ToolResultEvent;
		}
		return result;
	};
	return { api, fire };
}

function editDiff(added: number, removed: number): string {
	const lines: string[] = [];
	for (let i = 0; i < removed; i++) lines.push(`-${i} removed`);
	for (let i = 0; i < added; i++) lines.push(`+${i} added`);
	return lines.join("\n");
}

describe("auditPatchResult", () => {
	it("skips small edit diffs", () => {
		const decision = auditPatchResult({
			toolName: "edit",
			input: { path: "a.ts" },
			details: { diff: editDiff(2, 1) },
			isError: false,
		});
		expect(decision).toEqual({ action: "skip" });
	});

	it("appends a medium-risk directive for non-trivial edit diffs", () => {
		const decision = auditPatchResult({
			toolName: "edit",
			input: { path: "a.ts" },
			details: { diff: editDiff(30, 20) },
			isError: false,
		});
		expect(decision.action).toBe("append");
		if (decision.action === "append") {
			expect(decision.audit.risk).toBe("medium");
			expect(decision.audit.changedLines).toBe(50);
			expect(decision.message).toContain("Patch audit: medium-risk");
			expect(decision.message).toContain("self-review this diff:");
			// Medium-risk gets the shorter 3-item checklist.
			expect(decision.message.match(/- \[ \] /g)).toHaveLength(3);
		}
	});

	it("appends a high-risk directive for large writes", () => {
		const content = Array.from({ length: 180 }, (_, index) => `line ${index}`).join("\n");
		const decision = auditPatchResult({
			toolName: "write",
			input: { path: "large.ts", content },
			details: undefined,
			isError: false,
		});
		expect(decision.action).toBe("append");
		if (decision.action === "append") {
			expect(decision.audit.risk).toBe("high");
			expect(decision.audit.changedLines).toBe(180);
			expect(decision.message).toContain("Patch audit: high-risk");
			expect(decision.message).toContain("self-review this diff:");
			expect(decision.message).toContain("- [ ] ");
			// High-risk gets the extended checklist (5 items), medium gets 3.
			expect(decision.message.match(/- \[ \] /g)).toHaveLength(5);
			expect(decision.message).toContain("Run the relevant verification");
		}
	});

	it("skips errors and preview writes", () => {
		expect(
			auditPatchResult({
				toolName: "write",
				input: { path: "a.ts", content: "x" },
				details: undefined,
				isError: true,
			}),
		).toEqual({ action: "skip" });
		expect(
			auditPatchResult({
				toolName: "write",
				input: { path: "a.ts", content: Array.from({ length: 180 }, () => "x").join("\n"), preview: true },
				details: undefined,
				isError: false,
			}),
		).toEqual({ action: "skip" });
	});
});

describe("TurnRiskAccumulator", () => {
	function editResult(added: number, removed: number, path = "a.ts") {
		return { toolName: "edit", input: { path }, details: { diff: editDiff(added, removed) }, isError: false };
	}

	it("sums many sub-threshold edits into an aggregate high", () => {
		const acc = new TurnRiskAccumulator();
		// Five 30-changed-line edits: each individually LOW (< 40 medium), but the
		// cycle total is 150 (>= 120) — the gap a per-patch scorer misses.
		for (let i = 0; i < 5; i++) acc.add(editResult(20, 10, `file-${i}.ts`));
		const totals = acc.getTotals();
		expect(totals.mutations).toBe(5);
		expect(totals.changedLines).toBe(150);
		expect(totals.aggregateRisk).toBe("high");
		// No single patch reached medium/high on its own.
		expect(totals.maxPatchRisk).toBe("low");
		expect(totals.touchedFiles).toHaveLength(5);
	});

	it("classifies a mid-size aggregate as medium", () => {
		const acc = new TurnRiskAccumulator();
		acc.add(editResult(20, 10)); // 30
		acc.add(editResult(20, 10)); // +30 = 60 (>= 40 medium, < 120 high)
		const totals = acc.getTotals();
		expect(totals.changedLines).toBe(60);
		expect(totals.aggregateRisk).toBe("medium");
	});

	it("tracks the highest single-patch risk independent of the aggregate", () => {
		const acc = new TurnRiskAccumulator();
		acc.add(editResult(80, 50)); // 130 changed lines in one patch → high
		const totals = acc.getTotals();
		expect(totals.maxPatchRisk).toBe("high");
		expect(totals.aggregateRisk).toBe("high");
	});

	it("accumulates changed lines per file and ignores non-mutating results", () => {
		const acc = new TurnRiskAccumulator();
		acc.add(editResult(10, 5, "same.ts")); // 15
		acc.add(editResult(4, 1, "same.ts")); // +5 = 20 on same.ts
		// Errored + preview results contribute nothing.
		acc.add({ toolName: "edit", input: { path: "err.ts" }, details: { diff: editDiff(50, 50) }, isError: true });
		acc.add({
			toolName: "write",
			input: { path: "p.ts", content: "x\n".repeat(200), preview: true },
			details: undefined,
			isError: false,
		});
		const totals = acc.getTotals();
		expect(totals.mutations).toBe(2);
		expect(totals.touchedFiles).toEqual([{ path: "same.ts", changedLines: 20, diff: expect.any(String) }]);
	});

	it("resets all cycle state", () => {
		const acc = new TurnRiskAccumulator();
		acc.add(editResult(80, 60));
		acc.reset();
		const totals = acc.getTotals();
		expect(totals).toEqual({
			mutations: 0,
			changedLines: 0,
			aggregateRisk: "low",
			maxPatchRisk: "low",
			touchedFiles: [],
		});
	});
});

describe("isPatchAuditDisabled", () => {
	it("is controlled by PIT_NO_PATCH_AUDIT", () => {
		expect(isPatchAuditDisabled({})).toBe(false);
		expect(isPatchAuditDisabled({ PIT_NO_PATCH_AUDIT: "1" })).toBe(true);
		expect(isPatchAuditDisabled({ PIT_NO_PATCH_AUDIT: "TRUE" })).toBe(true);
		expect(isPatchAuditDisabled({ PIT_NO_PATCH_AUDIT: "0" })).toBe(false);
	});
});

describe("createPatchAuditExtension", () => {
	it("appends a directive and records diagnostics for medium-risk patches", () => {
		resetRuntimeDiagnostics();
		const { api, fire } = makeFakePi();
		createPatchAuditExtension()(api);

		const result = fire({
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "edit",
			input: { path: "a.ts" },
			content: [{ type: "text", text: "Successfully replaced text." }],
			details: { diff: editDiff(30, 20) },
			isError: false,
		});

		expect(result?.isError).toBeUndefined();
		expect(result?.content?.at(-1)).toEqual({
			type: "text",
			text: expect.stringContaining("Patch audit: medium-risk"),
		});
		const diagnostic = getRuntimeDiagnostics().recent.find((event) => event.source === "patch-audit-extension");
		expect(diagnostic?.category).toBe("guard.patch-audit");
		expect(diagnostic?.context?.path).toBe("a.ts");
		expect(diagnostic?.context?.note).toContain("medium 50 changed lines");
		// Advisory guard: risk-tier ruleId, and NO outcome (it never blocks/overrides).
		expect(diagnostic?.context?.ruleId).toBe("patch-risk-medium");
		expect(diagnostic?.context?.outcome).toBeUndefined();
	});

	it("does not append on failed tool results", () => {
		const { api, fire } = makeFakePi();
		createPatchAuditExtension()(api);

		const result = fire({
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "edit",
			input: { path: "a.ts" },
			content: [{ type: "text", text: "Edit failed." }],
			details: { diff: editDiff(30, 20) },
			isError: true,
		});

		expect(result).toBeUndefined();
	});
});
