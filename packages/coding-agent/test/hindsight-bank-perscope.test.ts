import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBank } from "../src/core/hindsight/bank.ts";

let dir: string;
let path: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hs-perscope-"));
	path = join(dir, "bank.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("enforcePerScopeLimit", () => {
	it("caps a chatty scope, leaves global and other scopes untouched", () => {
		const b = openBank(path);
		for (let i = 0; i < 5; i++) b.add({ kind: "fact", body: `explore note ${i}`, agentScope: "explore" });
		b.add({ kind: "decision", body: "rare global decision", agentScope: undefined });
		b.add({ kind: "fact", body: "review note", agentScope: "review" });

		const removed = b.enforcePerScopeLimit(2);
		expect(removed).toBe(3);
		const byScope = (s: string | undefined) => b.all().filter((e) => e.agentScope === s);
		expect(byScope("explore")).toHaveLength(2);
		expect(byScope(undefined)).toHaveLength(1); // global never capped
		expect(byScope("review")).toHaveLength(1);
	});

	it("runs at open time after age prune, before global enforceLimit", () => {
		const b1 = openBank(path);
		for (let i = 0; i < 4; i++) b1.add({ kind: "fact", body: `explore ${i}`, agentScope: "explore" });
		const b2 = openBank(path, { perScopeMax: 1 });
		expect(b2.all().filter((e) => e.agentScope === "explore")).toHaveLength(1);
	});
});
