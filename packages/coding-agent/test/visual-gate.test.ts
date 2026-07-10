/**
 * Integration test for the visual definition-of-done nudge: when a turn changes
 * a rendered artifact (.tsx/.html/.svg/...) without ever calling `preview`, the
 * gate injects a one-shot nudge to render and review it.
 */
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.js";

// No package.json in the harness temp dir → no code check command, so these
// tests isolate the visual nudge from the code-check loop.
describe("visual definition-of-done gate", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("nudges to preview when a visual file changed but was never viewed", async () => {
		const harness = await createHarness();
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
		const harness = await createHarness();
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
			settings: { verification: { visual: false, functionalWeb: false } },
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
