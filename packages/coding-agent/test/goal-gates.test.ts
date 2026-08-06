import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectGoalGateCommands, runGoalGates } from "../src/core/verification/goal-gates.js";

const dirs: string[] = [];
function project(scripts: Record<string, string>): string {
	const cwd = mkdtempSync(join(tmpdir(), "pit-goal-gates-"));
	dirs.push(cwd);
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts }));
	return cwd;
}
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("detectGoalGateCommands", () => {
	it("honors an explicit command", () => {
		const gates = detectGoalGateCommands(project({ check: "echo check" }), "custom verify");
		expect(gates).toEqual([
			{ id: "configured", label: "configured verification", command: "custom verify", source: "configured" },
		]);
	});
	it("uses check as an exclusive aggregator", () => {
		const gates = detectGoalGateCommands(project({ check: "echo check", lint: "echo lint", test: "echo test" }));
		expect(gates.map((gate) => gate.id)).toEqual(["script:check"]);
	});
	it("orders typecheck, lint and test when no aggregator exists", () => {
		const gates = detectGoalGateCommands(
			project({ "type-check": "echo type", lint: "echo lint", test: "echo test" }),
		);
		expect(gates.map((gate) => gate.id)).toEqual(["script:type-check", "script:lint", "script:test"]);
	});
	it("returns no gate without a local toolchain", () => {
		expect(detectGoalGateCommands(project({}), undefined, ["missing.ts"])).toEqual([]);
	});
	it("runs gates sequentially, stops on first failure, and caches passed ids", async () => {
		const cwd = project({});
		const gates = [
			{ id: "a", label: "a", command: "echo pass", source: "configured" as const },
			{ id: "b", label: "b", command: "exit 1", source: "configured" as const },
		];
		const failed = await runGoalGates(gates, cwd);
		expect(failed.status).toBe("failed");
		expect(failed.results.map((result) => result.gate.id)).toEqual(["a", "b"]);
		expect(failed.passedGateIds).toEqual(["a"]);
		const cached = await runGoalGates(gates, cwd, { passedGateIds: ["a", "b"] });
		expect(cached.status).toBe("passed");
		expect(cached.results).toHaveLength(0);
	});
});
