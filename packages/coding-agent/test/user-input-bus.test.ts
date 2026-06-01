import { describe, expect, it } from "vitest";
import { createUserInputBus } from "../src/core/user-input-bus.js";

describe("UserInputBus auto-answer (no listener)", () => {
	it("picks the recommended option when options exist", async () => {
		const bus = createUserInputBus();
		const ans = await bus.askOptions({
			question: "Pick",
			options: [{ label: "A" }, { label: "B", recommended: true }],
			source: {},
		});
		expect(ans).toMatchObject({ picked: ["B"], cancelled: false });
	});

	it("falls back to the first option when none is recommended", async () => {
		const bus = createUserInputBus();
		const ans = await bus.askOptions({
			question: "Pick",
			options: [{ label: "A" }, { label: "B" }],
			source: {},
		});
		expect(ans.picked).toEqual(["A"]);
	});

	it("returns an empty freeform answer for option-less prompts", async () => {
		const bus = createUserInputBus();
		const ans = await bus.askOptions({ question: "Describe", options: [], allowFreeform: true, source: {} });
		expect(ans).toMatchObject({ picked: [], freeformText: "", cancelled: false });
	});

	it("delivers a listener's answer when one is bound", async () => {
		const bus = createUserInputBus();
		bus.onRequest((req) => {
			bus.resolve(req.requestId, { picked: [], freeformText: "typed" });
		});
		const ans = await bus.askOptions({ question: "Describe", options: [], allowFreeform: true, source: {} });
		expect(ans).toMatchObject({ picked: [], freeformText: "typed" });
	});
});
