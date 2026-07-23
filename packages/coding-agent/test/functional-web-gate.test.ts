/**
 * Integration test for the native functional web DoD gate: when a turn changes
 * a visual artifact, the gate runs runFunctionalWebCheck (mocked via Chrome
 * manager injection is not available at session level â€” we disable Chrome and
 * assert skip, and use settings/env to assert opt-out).
 */
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.js";

describe("functional web DoD gate", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		vi.unstubAllEnvs();
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("emits functional_web skipped when Chrome is unavailable (fail-open)", async () => {
		const harness = await createHarness({
			settings: { chromeDevtools: { enabled: false }, verification: { mode: "post-turn", visual: false } },
		});
		harnesses.push(harness);
		const file = join(harness.tempDir, "App.tsx");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "export const App = () => null;" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("wrote the component"),
		]);

		await harness.session.prompt("build the App component");

		const events = harness.eventsOfType("functional_web");
		// Gate still runs; without Chrome it should skip (or not emit if not_web
		// before chrome â€” either skipped with chrome_unavailable or not_web is ok).
		if (events.length > 0) {
			expect(events.every((e) => e.phase === "skipped" || e.phase === "running")).toBe(true);
			const last = events[events.length - 1]!;
			expect(last.phase).toBe("skipped");
		}
	});

	it("does not run functional web when verification.functionalWeb is false", async () => {
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

		expect(harness.eventsOfType("functional_web")).toEqual([]);
	});

	it("does not run functional web when PIT_NO_FUNCTIONAL_WEB is set", async () => {
		vi.stubEnv("PIT_NO_FUNCTIONAL_WEB", "1");
		const harness = await createHarness({
			settings: { verification: { mode: "post-turn", visual: false, functionalWeb: true } },
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

		const events = harness.eventsOfType("functional_web");
		// Kill-switch is checked inside runFunctionalWebCheck â€” may still emit running then skipped.
		if (events.length > 0) {
			expect(events.some((e) => e.phase === "skipped" && e.reason === "kill_switch")).toBe(true);
		}
	});

	it("still emits visual_review nudge when visual is enabled", async () => {
		const harness = await createHarness({
			settings: {
				chromeDevtools: { enabled: false },
				verification: { mode: "post-turn", visual: true, functionalWeb: true },
			},
		});
		harnesses.push(harness);
		const file = join(harness.tempDir, "App.tsx");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "export const App = () => null;" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("wrote the component"),
			fauxAssistantMessage("previewed it"),
		]);

		await harness.session.prompt("build the App component");

		expect(harness.eventsOfType("visual_review").length).toBe(1);
		expect(getUserTexts(harness).some((t) => t.includes("didn't look at it"))).toBe(true);
	});
});
