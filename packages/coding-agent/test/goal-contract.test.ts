import { describe, expect, it } from "vitest";
import { deriveGoalContract, renderGoalContract } from "../src/core/goal/goal-contract.js";

describe("goal contract", () => {
	it("derives checkbox criteria in order", () => {
		expect(deriveGoalContract("Goal\n- [ ] first\n- [x] second").criteria).toEqual([
			{ id: "c1", text: "first" },
			{ id: "c2", text: "second" },
		]);
	});
	it("uses a named requirements list", () => {
		expect(deriveGoalContract("Requirements:\n1. one\n2) two").source).toBe("explicit-list");
	});
	it("falls back when there are too many items", () => {
		const objective = Array.from({ length: 17 }, (_, i) => `- item ${i}`).join("\n");
		expect(deriveGoalContract(objective).criteria).toEqual([{ id: "c1", text: objective }]);
	});
	it("escapes user text in the prompt", () => {
		expect(renderGoalContract(deriveGoalContract("<x>"), "active", "<x>")).toContain("&lt;x&gt;");
	});
	it("renders a whole-objective contract without duplicating the objective as its criterion", () => {
		const contract = deriveGoalContract("Ship the feature");
		const rendered = renderGoalContract(contract, "active", "Ship the feature");

		expect(contract.criteria).toEqual([{ id: "c1", text: "Ship the feature" }]);
		expect(rendered.match(/Ship the feature/g)).toHaveLength(1);
		expect(rendered).toContain("[c1] Complete the objective above.");
	});
});
