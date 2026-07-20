import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getLivingRepoMap = vi.fn();

vi.mock("../src/core/repo-map/living-index.ts", () => ({
	getLivingRepoMap: (...args: unknown[]) => getLivingRepoMap(...args),
}));

import {
	_resetImpactStateForTest,
	createImpactExtension,
	getCurrentCoveringTests,
	getCurrentPredictedImpactPaths,
	getCurrentUnreviewedImpact,
	wasFileInPredictedImpact,
} from "../src/core/built-ins/impact-extension.ts";
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
	const fire = async (event: string, payload?: unknown, ctx?: unknown): Promise<unknown> => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) {
			const r = await handler(payload, ctx);
			if (r !== undefined && result === undefined) result = r;
		}
		return result;
	};
	return { api, fire };
}

const cwd = process.cwd();

/** One RepoMapEntry fixture; `deps` omitted entirely when absent (mirrors a v2/PIT_NO_REPO_GRAPH cache). */
function entry(path: string, deps?: string[]): Record<string, unknown> {
	return { path, symbols: ["x"], mtimeMs: 1, ...(deps ? { deps } : {}) };
}

function mockMap(entries: Array<Record<string, unknown>>): void {
	getLivingRepoMap.mockResolvedValue({
		map: { version: 4, lastIndexedCommit: "abc", entries },
		mode: "cache-hit",
		reindexedCount: 0,
	});
}

function editResult(path: string): Record<string, unknown> {
	return {
		type: "tool_result",
		toolCallId: "c1",
		toolName: "edit",
		input: { path },
		content: [{ type: "text", text: "Successfully replaced text." }],
		details: { diff: "+x" },
		isError: false,
	};
}

function readResult(path: string): Record<string, unknown> {
	return {
		type: "tool_result",
		toolCallId: "c2",
		toolName: "read",
		input: { path },
		content: [{ type: "text", text: "file contents" }],
		details: undefined,
		isError: false,
	};
}

function lspResult(file: string): Record<string, unknown> {
	return {
		type: "tool_result",
		toolCallId: "c3",
		toolName: "lsp",
		input: { action: "diagnostics", file },
		content: [{ type: "text", text: "no diagnostics" }],
		details: undefined,
		isError: false,
	};
}

function textOf(result: any): string {
	return (result?.content ?? []).map((c: any) => c.text ?? "").join("");
}

describe("createImpactExtension", () => {
	beforeEach(() => {
		getLivingRepoMap.mockReset();
		_resetImpactStateForTest();
		resetRuntimeDiagnostics();
	});
	afterEach(() => {
		delete process.env.PIT_NO_IMPACT_GUARD;
		_resetImpactStateForTest();
	});

	it("appends a bounded advisory (direct + 2-hop groups) and feeds pending with DIRECT dependents only", async () => {
		mockMap([
			entry("src/seed.ts"),
			entry("src/a.ts", ["src/seed.ts"]),
			entry("src/b.ts", ["src/seed.ts"]),
			entry("src/c.ts", ["src/seed.ts"]),
			entry("src/d.ts", ["src/a.ts"]), // 2 hops from seed via a.ts
		]);
		const { api, fire } = makeFakePi();
		createImpactExtension({ cwd })(api as unknown as ExtensionAPI);

		const result = await fire("tool_result", editResult("src/seed.ts"));
		expect(textOf(result)).toContain(
			"Impact graph: 4 file(s) depend on this one — src/a.ts, src/b.ts, src/c.ts (direct); src/d.ts (2 hops). Review them before declaring done.",
		);

		// Only the DIRECT (distance 1) dependents are tracked for the completion gate.
		const pending = getCurrentUnreviewedImpact();
		expect(pending.map((p) => p.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
		expect(pending[0]).toEqual({ path: "src/a.ts", seeds: ["src/seed.ts"] });

		// The 2-hop file is still "predicted" (it was named in the advisory) even
		// though it never entered `pending`.
		expect(wasFileInPredictedImpact("src/d.ts")).toBe(true);

		const diag = getRuntimeDiagnostics().recent.find((e) => e.source === "impact-extension");
		expect(diag?.category).toBe("quality.impact-guard");
		expect(diag?.context?.ruleId).toBe("impact-advisory");
	});

	it("emits no note and feeds nothing when the edited file has zero dependents", async () => {
		mockMap([entry("src/lonely.ts")]);
		const { api, fire } = makeFakePi();
		createImpactExtension({ cwd })(api as unknown as ExtensionAPI);

		const result = await fire("tool_result", editResult("src/lonely.ts"));
		expect(result).toBeUndefined();
		expect(getCurrentUnreviewedImpact()).toEqual([]);
	});

	it("caps the displayed list at 5 paths and folds the rest into +N more", async () => {
		const dependents = Array.from({ length: 7 }, (_, i) => `src/dep${i}.ts`);
		mockMap([entry("src/seed.ts"), ...dependents.map((p) => entry(p, ["src/seed.ts"]))]);
		const { api, fire } = makeFakePi();
		createImpactExtension({ cwd })(api as unknown as ExtensionAPI);

		const result = await fire("tool_result", editResult("src/seed.ts"));
		const text = textOf(result);
		expect(text).toContain("Impact graph: 7 file(s) depend on this one —");
		expect(text).toContain("+2 more");
		// All 7 tracked as unreviewed (below the hub threshold).
		expect(getCurrentUnreviewedImpact()).toHaveLength(7);
	});

	it("clears a pending file once it is read, edited, or lsp-checked afterward", async () => {
		mockMap([
			entry("src/seed.ts"),
			entry("src/a.ts", ["src/seed.ts"]),
			entry("src/b.ts", ["src/seed.ts"]),
			entry("src/c.ts", ["src/seed.ts"]),
		]);
		const { api, fire } = makeFakePi();
		createImpactExtension({ cwd })(api as unknown as ExtensionAPI);

		await fire("tool_result", editResult("src/seed.ts"));
		expect(getCurrentUnreviewedImpact().map((p) => p.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);

		await fire("tool_result", readResult("src/a.ts"));
		expect(getCurrentUnreviewedImpact().map((p) => p.path)).toEqual(["src/b.ts", "src/c.ts"]);

		await fire("tool_result", editResult("src/b.ts"));
		expect(getCurrentUnreviewedImpact().map((p) => p.path)).toEqual(["src/c.ts"]);

		await fire("tool_result", lspResult("src/c.ts"));
		expect(getCurrentUnreviewedImpact()).toEqual([]);
	});

	it("resets pending + predicted state on turn_start", async () => {
		mockMap([entry("src/seed.ts"), entry("src/a.ts", ["src/seed.ts"])]);
		const { api, fire } = makeFakePi();
		createImpactExtension({ cwd })(api as unknown as ExtensionAPI);

		await fire("tool_result", editResult("src/seed.ts"));
		expect(getCurrentUnreviewedImpact()).toHaveLength(1);
		expect(wasFileInPredictedImpact("src/a.ts")).toBe(true);

		await fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });

		expect(getCurrentUnreviewedImpact()).toEqual([]);
		expect(wasFileInPredictedImpact("src/a.ts")).toBe(false);
	});

	it("treats >15 direct dependents as a hub file: skips pending but still counts as predicted", async () => {
		const dependents = Array.from({ length: 16 }, (_, i) => `src/hub-dep${i}.ts`);
		mockMap([entry("src/hub.ts"), ...dependents.map((p) => entry(p, ["src/hub.ts"]))]);
		const { api, fire } = makeFakePi();
		createImpactExtension({ cwd })(api as unknown as ExtensionAPI);

		const result = await fire("tool_result", editResult("src/hub.ts"));
		const text = textOf(result);
		expect(text).toContain("Impact graph: 16 file(s) depend on this one —");
		expect(text).toContain("(hub file — rely on the project check).");
		expect(text).not.toContain("Review them before declaring done.");

		// Nothing fed into the completion-gate registry…
		expect(getCurrentUnreviewedImpact()).toEqual([]);
		// …but every direct dependent still counts as "predicted" for telemetry.
		expect(wasFileInPredictedImpact("src/hub-dep0.ts")).toBe(true);
		expect(wasFileInPredictedImpact("src/hub-dep15.ts")).toBe(true);

		const diag = getRuntimeDiagnostics().recent.find((e) => e.source === "impact-extension");
		expect(diag?.context?.ruleId).toBe("impact-hub");
	});

	it("getCurrentPredictedImpactPaths returns every surfaced path, sorted (Fase 3)", async () => {
		mockMap([
			entry("src/seed.ts"),
			entry("src/a.ts", ["src/seed.ts"]),
			entry("src/b.ts", ["src/seed.ts"]),
			entry("src/c.ts", ["src/seed.ts"]),
			entry("src/d.ts", ["src/a.ts"]), // 2 hops from seed via a.ts
		]);
		const { api, fire } = makeFakePi();
		createImpactExtension({ cwd })(api as unknown as ExtensionAPI);

		expect(getCurrentPredictedImpactPaths()).toEqual([]);
		await fire("tool_result", editResult("src/seed.ts"));
		// Every hop the advisory named (direct + 2-hop), sorted — not just the
		// DIRECT-only `pending` set.
		expect(getCurrentPredictedImpactPaths()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
	});

	it("getCurrentPredictedImpactPaths resets on turn_start", async () => {
		mockMap([entry("src/seed.ts"), entry("src/a.ts", ["src/seed.ts"])]);
		const { api, fire } = makeFakePi();
		createImpactExtension({ cwd })(api as unknown as ExtensionAPI);

		await fire("tool_result", editResult("src/seed.ts"));
		expect(getCurrentPredictedImpactPaths()).toEqual(["src/a.ts"]);

		await fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
		expect(getCurrentPredictedImpactPaths()).toEqual([]);
	});

	it("routes test-path direct dependents to coveringTests, NOT pending, still counting as predicted (Fase 4B)", async () => {
		mockMap([entry("src/seed.ts"), entry("src/a.ts", ["src/seed.ts"]), entry("test/seed.test.ts", ["src/seed.ts"])]);
		const { api, fire } = makeFakePi();
		createImpactExtension({ cwd })(api as unknown as ExtensionAPI);

		const result = await fire("tool_result", editResult("src/seed.ts"));
		const text = textOf(result);
		// Advisory still lists both dependents, plus the covering-tests suffix.
		expect(text).toContain("Impact graph: 2 file(s) depend on this one —");
		expect(text).toContain("Tests covering this: test/seed.test.ts.");

		// The test file is NOT pending (the right action is to RUN it, not read it)…
		expect(getCurrentUnreviewedImpact().map((p) => p.path)).toEqual(["src/a.ts"]);
		// …it lives in the covering-tests registry instead…
		expect(getCurrentCoveringTests()).toEqual(["test/seed.test.ts"]);
		// …and it still counts as "predicted" for the cross-file-escape telemetry.
		expect(wasFileInPredictedImpact("test/seed.test.ts")).toBe(true);
	});

	it("caps the advisory covering-tests suffix at 3 and folds the rest into +N more", async () => {
		const tests = Array.from({ length: 5 }, (_, i) => `test/dep${i}.test.ts`);
		mockMap([entry("src/seed.ts"), ...tests.map((p) => entry(p, ["src/seed.ts"]))]);
		const { api, fire } = makeFakePi();
		createImpactExtension({ cwd })(api as unknown as ExtensionAPI);

		const result = await fire("tool_result", editResult("src/seed.ts"));
		const text = textOf(result);
		expect(text).toContain("Tests covering this: test/dep0.test.ts, test/dep1.test.ts, test/dep2.test.ts, +2 more.");
		// All 5 dependents are tests: nothing pends, all are covering tests.
		expect(getCurrentUnreviewedImpact()).toEqual([]);
		expect(getCurrentCoveringTests()).toHaveLength(5);
	});

	it("emits no covering-tests suffix when no direct dependent is a test", async () => {
		mockMap([entry("src/seed.ts"), entry("src/a.ts", ["src/seed.ts"])]);
		const { api, fire } = makeFakePi();
		createImpactExtension({ cwd })(api as unknown as ExtensionAPI);

		const result = await fire("tool_result", editResult("src/seed.ts"));
		expect(textOf(result)).not.toContain("Tests covering this:");
		expect(getCurrentCoveringTests()).toEqual([]);
	});

	it("resets coveringTests on turn_start", async () => {
		mockMap([entry("src/seed.ts"), entry("test/seed.test.ts", ["src/seed.ts"])]);
		const { api, fire } = makeFakePi();
		createImpactExtension({ cwd })(api as unknown as ExtensionAPI);

		await fire("tool_result", editResult("src/seed.ts"));
		expect(getCurrentCoveringTests()).toEqual(["test/seed.test.ts"]);

		await fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
		expect(getCurrentCoveringTests()).toEqual([]);
	});

	it("is fully disabled by PIT_NO_IMPACT_GUARD", async () => {
		process.env.PIT_NO_IMPACT_GUARD = "1";
		mockMap([entry("src/seed.ts"), entry("src/a.ts", ["src/seed.ts"])]);
		const { api, fire } = makeFakePi();
		createImpactExtension({ cwd })(api as unknown as ExtensionAPI);

		const result = await fire("tool_result", editResult("src/seed.ts"));
		expect(result).toBeUndefined();
		expect(getCurrentUnreviewedImpact()).toEqual([]);
	});

	it("degrades to a no-op when entries carry no deps (PIT_NO_REPO_GRAPH shape)", async () => {
		// No `deps` field on any entry — mirrors a v2 cache / PIT_NO_REPO_GRAPH.
		mockMap([entry("src/seed.ts"), entry("src/a.ts")]);
		const { api, fire } = makeFakePi();
		createImpactExtension({ cwd })(api as unknown as ExtensionAPI);

		const result = await fire("tool_result", editResult("src/seed.ts"));
		expect(result).toBeUndefined();
		expect(getCurrentUnreviewedImpact()).toEqual([]);
	});
});
