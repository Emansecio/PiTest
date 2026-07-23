/**
 * Integration test for the visual definition-of-done nudge: when a turn changes
 * a rendered artifact (.tsx/.html/.svg/...) without ever calling `preview`, the
 * gate injects a one-shot nudge to render and review it.
 */
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.js";

// Isolate the visual nudge from sibling verification phases that can hang under
// full-suite load (functional-web Chrome probes, self-review subagent up to 90s).
const VISUAL_ONLY = {
	verification: { mode: "post-turn", visual: true, functionalWeb: false },
} as const;

describe("visual definition-of-done gate", () => {
	const harnesses: Harness[] = [];
	const prevSelfReview = process.env.PIT_NO_SELF_REVIEW;

	beforeEach(() => {
		process.env.PIT_NO_SELF_REVIEW = "1";
	});

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
		if (prevSelfReview === undefined) delete process.env.PIT_NO_SELF_REVIEW;
		else process.env.PIT_NO_SELF_REVIEW = prevSelfReview;
	});

	it("nudges to preview when a visual file changed but was never viewed", async () => {
		const harness = await createHarness({ settings: { ...VISUAL_ONLY } });
		harnesses.push(harness);
		const file = join(harness.tempDir, "App.tsx");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "export const App = () => null;" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("wrote the component"),
			// Response to the injected visual nudge.
			fauxAssistantMessage("previewed it, looks right"),
		]);

		await harness.session.prompt("build the App component");

		const reviews = harness.eventsOfType("visual_review");
		expect(reviews.length).toBe(1);
		expect(reviews[0].file).toBe(file);
		expect(getUserTexts(harness).some((t) => t.includes("didn't look at it"))).toBe(true);
	});

	it("does not nudge for a non-visual file", async () => {
		const harness = await createHarness({ settings: { ...VISUAL_ONLY } });
		harnesses.push(harness);
		const file = join(harness.tempDir, "notes.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("wrote notes"),
		]);

		await harness.session.prompt("write some notes");

		expect(harness.eventsOfType("visual_review")).toEqual([]);
	});

	it("does not nudge when verification.visual is disabled", async () => {
		const harness = await createHarness({
			settings: { verification: { mode: "post-turn", visual: false, functionalWeb: false } },
		});
		harnesses.push(harness);
		const file = join(harness.tempDir, "page.html");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "<h1>hi</h1>" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("wrote the page"),
		]);

		await harness.session.prompt("build a page");

		expect(harness.eventsOfType("visual_review")).toEqual([]);
	});
});
