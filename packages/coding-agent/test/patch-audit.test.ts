import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { createPatchAuditExtension } from "../src/core/built-ins/patch-audit-extension.ts";
import type { ExtensionAPI, ToolResultEvent, ToolResultEventResult } from "../src/core/extensions/types.ts";
import { auditPatchResult, isPatchAuditDisabled } from "../src/core/patch-audit.ts";

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
			expect(decision.message).toContain("run the relevant verification");
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
