import { describe, expect, it, vi } from "vitest";
import type { HindsightBank } from "../src/core/hindsight/bank.ts";
import { createForgetToolDefinition } from "../src/core/tools/forget.ts";
import { withAgentScope } from "../src/core/tools/hindsight-scope.ts";
import { createRecallToolDefinition } from "../src/core/tools/recall.ts";
import { createRetainToolDefinition } from "../src/core/tools/retain.ts";

function fakeBank(): HindsightBank {
	return {
		add: vi.fn().mockReturnValue({ id: "x", createdAt: 0, updatedAt: 0, kind: "fact", body: "b" }),
		get: vi.fn(),
		delete: vi.fn().mockReturnValue(true),
		search: vi.fn().mockReturnValue([]),
		all: vi.fn().mockReturnValue([]),
		clear: vi.fn(),
		pruneOlderThan: vi.fn().mockReturnValue(0),
		enforceLimit: vi.fn().mockReturnValue(0),
		enforcePerScopeLimit: vi.fn().mockReturnValue(0),
	} as unknown as HindsightBank;
}

describe("scoped hindsight tools", () => {
	it("retain stamps the bound agentScope", async () => {
		const bank = fakeBank();
		const def = createRetainToolDefinition("/cwd", { bank, agentScope: "review" });
		await def.execute("call-1", { body: "fact body" }, undefined, undefined, undefined as never);
		expect(bank.add).toHaveBeenCalledWith(expect.objectContaining({ agentScope: "review" }));
	});

	it("scoped recall default reads own + global with own boosted", async () => {
		const bank = fakeBank();
		const def = createRecallToolDefinition("/cwd", { bank, agentScope: "review" });
		await def.execute("c", { query: "q" }, undefined, undefined, undefined as never);
		expect(bank.search).toHaveBeenCalledWith(
			expect.objectContaining({ scopes: ["review", null], boostScope: "review" }),
		);
	});

	it("main recall (no bound scope) reads all scopes, global boosted", async () => {
		const bank = fakeBank();
		const def = createRecallToolDefinition("/cwd", { bank });
		await def.execute("c", { query: "q" }, undefined, undefined, undefined as never);
		const arg = (bank.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(arg.scopes).toBeUndefined();
		expect(arg.boostScope).toBeNull();
	});

	it("recall scope:'global' forces global only", async () => {
		const bank = fakeBank();
		const def = createRecallToolDefinition("/cwd", { bank, agentScope: "review" });
		await def.execute("c", { query: "q", scope: "global" }, undefined, undefined, undefined as never);
		expect(bank.search).toHaveBeenCalledWith(expect.objectContaining({ scopes: [null] }));
	});

	it("recall scope:'all' clears the filter", async () => {
		const bank = fakeBank();
		const def = createRecallToolDefinition("/cwd", { bank, agentScope: "review" });
		await def.execute("c", { query: "q", scope: "all" }, undefined, undefined, undefined as never);
		const arg = (bank.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(arg.scopes).toBeUndefined();
	});

	it("scoped forget by subject cannot target another scope", async () => {
		const bank = fakeBank();
		(bank.all as ReturnType<typeof vi.fn>).mockReturnValue([
			{ id: "1", kind: "fact", body: "a", subject: "dup", agentScope: "explore" },
			{ id: "2", kind: "fact", body: "b", subject: "dup", agentScope: "review" },
		]);
		const def = createForgetToolDefinition("/cwd", { bank, agentScope: "review" });
		await def.execute("c", { subject: "dup" }, undefined, undefined, undefined as never);
		expect(bank.delete).toHaveBeenCalledWith("2");
	});
});

describe("withAgentScope", () => {
	it("is a no-op without a scope", () => {
		const tools = [{ name: "read" } as never];
		expect(withAgentScope(tools, undefined, "/cwd")).toBe(tools);
	});

	it("replaces existing hindsight tools and auto-adds when requested", () => {
		const base = [{ name: "read" } as never, { name: "recall" } as never];
		const out = withAgentScope(base, "review", "/cwd", true);
		const names = out.map((t) => t.name).sort();
		expect(names).toContain("recall");
		expect(names).toContain("retain");
		expect(names).toContain("reflect");
		expect(names).toContain("read");
		// recall instance was replaced (new object), not the placeholder
		expect(out.find((t) => t.name === "recall")).not.toBe(base[1]);
	});
});
