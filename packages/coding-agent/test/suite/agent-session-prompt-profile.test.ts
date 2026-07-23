/**
 * P7 — tiered system prompt: integration coverage for the model → profile
 * wiring in AgentSession (boot + `setModel`). Unit coverage for the profile
 * text itself (`buildSystemPrompt({ profile: ... })`) and the resolver
 * (`resolvePromptProfile`) lives in `test/system-prompt.test.ts`; unit
 * coverage for the weak-model predicate lives in `test/repair-note-policy.test.ts`.
 *
 * The faux provider always reports `provider: "faux"` (never in the native
 * frontier set), so these tests select weak vs. strong purely via model id,
 * matching (or not) `STRONG_MODEL_ID_PATTERN`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

const WEAK_MODEL_ID = "weak-oss-a";
const WEAK_MODEL_ID_2 = "weak-oss-b";
const STRONG_MODEL_ID = "gemini-2.5-pro"; // matches STRONG_MODEL_ID_PATTERN -> "full"

describe("AgentSession P7 tiered system prompt (model -> profile wiring)", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("boots with the compact profile when the initial model is weak/open", async () => {
		const harness = await createHarness({ models: [{ id: WEAK_MODEL_ID }] });
		harnesses.push(harness);

		expect(harness.session.systemPrompt).toContain("Explore with the least tool needed");
		expect(harness.session.systemPrompt).not.toContain(
			"Treat the user as an experienced professional: deliver the requested work directly",
		);
	});

	it("boots with the full profile when the initial model is a native frontier id", async () => {
		const harness = await createHarness({ models: [{ id: STRONG_MODEL_ID }] });
		harnesses.push(harness);

		expect(harness.session.systemPrompt).toContain(
			"Treat the user as an experienced professional: deliver the requested work directly",
		);
		expect(harness.session.systemPrompt).not.toContain("Explore with the least tool needed");
	});

	it("setModel weak -> frontier rebuilds the prompt to the full profile", async () => {
		const harness = await createHarness({ models: [{ id: WEAK_MODEL_ID }, { id: STRONG_MODEL_ID }] });
		harnesses.push(harness);
		expect(harness.session.systemPrompt).toContain("Explore with the least tool needed");

		await harness.session.setModel(harness.getModel(STRONG_MODEL_ID)!);

		expect(harness.session.systemPrompt).toContain(
			"Treat the user as an experienced professional: deliver the requested work directly",
		);
		expect(harness.session.systemPrompt).not.toContain("Explore with the least tool needed");
	});

	it("setModel frontier -> weak rebuilds the prompt back to the compact profile", async () => {
		const harness = await createHarness({ models: [{ id: STRONG_MODEL_ID }, { id: WEAK_MODEL_ID }] });
		harnesses.push(harness);
		expect(harness.session.systemPrompt).toContain(
			"Treat the user as an experienced professional: deliver the requested work directly",
		);

		await harness.session.setModel(harness.getModel(WEAK_MODEL_ID)!);

		expect(harness.session.systemPrompt).toContain("Explore with the least tool needed");
		expect(harness.session.systemPrompt).not.toContain(
			"Treat the user as an experienced professional: deliver the requested work directly",
		);
	});

	it("setModel between two weak models (same profile) leaves the system prompt untouched", async () => {
		const harness = await createHarness({ models: [{ id: WEAK_MODEL_ID }, { id: WEAK_MODEL_ID_2 }] });
		harnesses.push(harness);
		const before = harness.session.systemPrompt;

		await harness.session.setModel(harness.getModel(WEAK_MODEL_ID_2)!);

		expect(harness.session.systemPrompt).toBe(before);
	});

	describe("PIT_TIERED_PROMPT / PIT_NO_TIERED_PROMPT overrides (end-to-end through AgentSession)", () => {
		const prevTiered = process.env.PIT_TIERED_PROMPT;
		const prevNoTiered = process.env.PIT_NO_TIERED_PROMPT;

		afterEach(() => {
			if (prevTiered === undefined) delete process.env.PIT_TIERED_PROMPT;
			else process.env.PIT_TIERED_PROMPT = prevTiered;
			if (prevNoTiered === undefined) delete process.env.PIT_NO_TIERED_PROMPT;
			else process.env.PIT_NO_TIERED_PROMPT = prevNoTiered;
		});

		it("PIT_TIERED_PROMPT=compact forces compact even for a frontier model at boot", async () => {
			delete process.env.PIT_NO_TIERED_PROMPT;
			process.env.PIT_TIERED_PROMPT = "compact";
			const harness = await createHarness({ models: [{ id: STRONG_MODEL_ID }] });
			harnesses.push(harness);

			expect(harness.session.systemPrompt).toContain("Explore with the least tool needed");
		});

		it("PIT_NO_TIERED_PROMPT disables tiering (always full) even for a weak model, and survives a setModel", async () => {
			delete process.env.PIT_TIERED_PROMPT;
			process.env.PIT_NO_TIERED_PROMPT = "1";
			const harness = await createHarness({ models: [{ id: WEAK_MODEL_ID }, { id: WEAK_MODEL_ID_2 }] });
			harnesses.push(harness);

			expect(harness.session.systemPrompt).toContain(
				"Treat the user as an experienced professional: deliver the requested work directly",
			);

			await harness.session.setModel(harness.getModel(WEAK_MODEL_ID_2)!);

			expect(harness.session.systemPrompt).toContain(
				"Treat the user as an experienced professional: deliver the requested work directly",
			);
		});
	});
});
