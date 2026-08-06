import { describe, expect, it } from "vitest";
import { armVerificationGate, type VerificationGateState } from "../src/core/agent-session-tool-end.js";
import { GoalManager } from "../src/core/goal/goal-manager.js";

function state(): VerificationGateState {
	return { turnTouchedFiles: false, turnTouchedFilePaths: new Set(), turnTouchedVisual: false };
}

describe("Goal mutation tracking", () => {
	it("records successful file mutations but not reads, with event dedupe", () => {
		const manager = new GoalManager({ now: () => 0, genId: () => "g1" });
		manager.start("change files", {});
		const gate = state();
		const record = (path: string | undefined, eventKey?: string) => manager.recordMutation(path, eventKey);

		armVerificationGate(gate, "read", { path: "src/a.ts" }, { onMutation: record, eventKey: "read-1" });
		expect(manager.get()?.mutationRevision).toBeUndefined();
		armVerificationGate(gate, "edit", { path: "src/a.ts" }, { onMutation: record, eventKey: "edit-1" });
		armVerificationGate(gate, "edit", { path: "src/a.ts" }, { onMutation: record, eventKey: "edit-1" });
		expect(manager.get()?.mutationRevision).toBe(1);
		expect(manager.get()?.mutatedPaths).toEqual(["src/a.ts"]);
	});

	it("invalidates gate state and caps normalized paths", () => {
		const manager = new GoalManager({ now: () => 0, genId: () => "g1" });
		manager.start("change files", {});
		for (let i = 0; i < 55; i += 1) manager.recordMutation(`./src\\file-${i}.ts`);
		const snapshot = manager.get();
		expect(snapshot?.mutationRevision).toBe(55);
		expect(snapshot?.mutatedPaths).toHaveLength(50);
		expect(snapshot?.mutatedPaths?.[0]).toBe("src/file-5.ts");
		expect(snapshot?.gateProgress).toBeUndefined();
		expect(snapshot?.gateFailure).toBeUndefined();
	});

	it("does not record mutations for completed or absent goals", () => {
		const manager = new GoalManager({ now: () => 0, genId: () => "g1" });
		manager.recordMutation("src/a.ts");
		expect(manager.get()).toBeUndefined();
		manager.start("done", {});
		manager.complete("done");
		manager.recordMutation("src/a.ts");
		expect(manager.get()?.mutationRevision).toBeUndefined();
	});
});
