import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const groundToolCall = vi.fn();

vi.mock("../src/core/grounding-guard.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/grounding-guard.ts")>();
	return {
		...actual,
		groundToolCall: (...args: unknown[]) => groundToolCall(...args),
		isGroundingGuardDisabled: () => false,
	};
});

vi.mock("../src/core/repo-map/living-index.ts", () => ({
	getLivingRepoMap: vi.fn(async () => ({ map: { files: [] } })),
}));

vi.mock("../src/core/lsp/manager.ts", () => ({
	getConfig: vi.fn(() => ({})),
	getLspServers: vi.fn(() => []),
}));

import { createGroundingGuardExtension } from "../src/core/built-ins/grounding-guard-extension.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

type Handler = (event: any, ctx?: any) => unknown;

function makeFakePi() {
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	const fire = async (event: string, payload: any, ctx?: any): Promise<unknown> => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) {
			const r = await handler(payload, ctx);
			if (r !== undefined && result === undefined) result = r;
		}
		return result;
	};
	return { api, fire };
}

describe("grounding-guard-extension", () => {
	beforeEach(() => {
		groundToolCall.mockReset();
		resetRuntimeDiagnostics();
	});

	it("blocks once then allows identical re-issue (fire-once override)", async () => {
		groundToolCall.mockResolvedValue({
			action: "block",
			message: "Symbol TypoFn not found",
		});
		const { api, fire } = makeFakePi();
		createGroundingGuardExtension({ cwd: process.cwd() })(api as unknown as ExtensionAPI);

		const payload = {
			toolName: "lsp",
			toolCallId: "c1",
			input: { action: "symbols", file: "*", query: "TypoFn" },
		};
		const first = await fire("tool_call", payload);
		expect(first).toEqual({ block: true, reason: "Symbol TypoFn not found" });

		const second = await fire("tool_call", payload);
		expect(second).toBeUndefined();

		const events = getRuntimeDiagnostics().recent.filter((e) => e.category === "guard.grounding");
		expect(events.map((e) => e.context?.outcome)).toEqual(["blocked", "overridden"]);
	});

	it("rewrites args in place on rewrite decision", async () => {
		groundToolCall.mockResolvedValue({
			action: "rewrite",
			args: { action: "symbols", file: "*", query: "TypeFn" },
		});
		const { api, fire } = makeFakePi();
		createGroundingGuardExtension({ cwd: process.cwd() })(api as unknown as ExtensionAPI);

		const input = { action: "symbols", file: "*", query: "TypoFn" };
		const result = await fire("tool_call", { toolName: "lsp", toolCallId: "c1", input });
		expect(result).toBeUndefined();
		expect(input.query).toBe("TypeFn");
	});

	it("fail-opens when groundToolCall throws", async () => {
		groundToolCall.mockRejectedValue(new Error("boom"));
		const { api, fire } = makeFakePi();
		createGroundingGuardExtension({ cwd: process.cwd() })(api as unknown as ExtensionAPI);

		const result = await fire("tool_call", {
			toolName: "debug",
			toolCallId: "c1",
			input: { action: "breakpoint", name: "foo" },
		});
		expect(result).toBeUndefined();
	});
});
