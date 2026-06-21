import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBank } from "../src/core/hindsight/bank.ts";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hs-scope-"));
	path = join(dir, "bank.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("hindsight bank agentScope", () => {
	it("persists agentScope and round-trips it across reopen", () => {
		const b1 = openBank(path);
		b1.add({ kind: "fact", body: "review uses tsgo", agentScope: "review" });
		b1.add({ kind: "fact", body: "global build cmd", agentScope: undefined });
		const b2 = openBank(path);
		const all = b2.all();
		expect(all.find((e) => e.body.includes("review"))?.agentScope).toBe("review");
		expect(all.find((e) => e.body.includes("global"))?.agentScope).toBeUndefined();
	});

	it("scopes:[null] excludes scoped entries", () => {
		const b = openBank(path);
		b.add({ kind: "fact", body: "alpha token global", agentScope: undefined });
		b.add({ kind: "fact", body: "alpha token review", agentScope: "review" });
		const res = b.search({ query: "alpha token", scopes: [null] });
		expect(res).toHaveLength(1);
		expect(res[0].entry.agentScope).toBeUndefined();
	});

	it("scopes:[T,null] includes own + global, excludes other scopes", () => {
		const b = openBank(path);
		b.add({ kind: "fact", body: "beta token global", agentScope: undefined });
		b.add({ kind: "fact", body: "beta token review", agentScope: "review" });
		b.add({ kind: "fact", body: "beta token explore", agentScope: "explore" });
		const res = b.search({ query: "beta token", scopes: ["review", null] });
		const scopes = res.map((r) => r.entry.agentScope ?? null).sort();
		expect(scopes).toEqual([null, "review"]);
	});

	it("omitted scopes returns every scope (back-compat)", () => {
		const b = openBank(path);
		b.add({ kind: "fact", body: "gamma token global", agentScope: undefined });
		b.add({ kind: "fact", body: "gamma token review", agentScope: "review" });
		expect(b.search({ query: "gamma token" })).toHaveLength(2);
	});

	it("boostScope lifts the matching-scope entry above an equal global one", () => {
		const b = openBank(path);
		// identical bodies => identical BM25; boost should break the tie.
		b.add({ kind: "fact", body: "delta delta delta", agentScope: undefined });
		b.add({ kind: "fact", body: "delta delta delta", agentScope: "review" });
		const res = b.search({ query: "delta", scopes: ["review", null], boostScope: "review" });
		expect(res[0].entry.agentScope).toBe("review");
	});

	it("boostScope:null lifts the global entry (main-agent behavior)", () => {
		const b = openBank(path);
		b.add({ kind: "fact", body: "epsilon epsilon epsilon", agentScope: "review" });
		b.add({ kind: "fact", body: "epsilon epsilon epsilon", agentScope: undefined });
		const res = b.search({ query: "epsilon", boostScope: null });
		expect(res[0].entry.agentScope).toBeUndefined();
	});
});
