import { describe, expect, it } from "vitest";
import { buildSystemPrompt, patchSystemPromptToolSurface } from "../src/core/system-prompt.js";

function guidelinesBlock(prompt: string): string {
	const start = prompt.indexOf("\nGuidelines:\n");
	const docs = prompt.indexOf("\nWhen asked about pit itself,");
	expect(start).toBeGreaterThanOrEqual(0);
	expect(docs).toBeGreaterThan(start);
	return prompt.slice(start, docs);
}

describe("patchSystemPromptToolSurface", () => {
	it("splices tools without rewriting the dynamic suffix", () => {
		const base = buildSystemPrompt({
			cwd: "/repo",
			selectedTools: ["read", "bash", "edit", "write"],
			skills: [],
			contextFiles: [],
		});
		const patched = patchSystemPromptToolSurface(base, {
			selectedTools: ["read", "bash", "edit", "write", "grep"],
		});
		expect(patched).toBeDefined();
		expect(patched!).toContain("- grep");
		// Dynamic suffix (cwd) preserved from original build
		expect(patched!).toContain("Current working directory: /repo");
		// Docs section still present
		expect(patched!).toContain("When asked about pit itself");
	});

	it("preserves Guidelines byte-for-byte when only the tools list changes (T07)", () => {
		const base = buildSystemPrompt({
			cwd: "/repo",
			selectedTools: ["read", "bash", "edit", "write"],
			skills: [],
			contextFiles: [],
		});
		const patched = patchSystemPromptToolSurface(base, {
			selectedTools: ["read", "bash", "edit", "write", "grep"],
		});
		expect(patched).toBeDefined();
		expect(guidelinesBlock(patched!)).toBe(guidelinesBlock(base));
	});

	it("returns undefined for custom prompts without anchors", () => {
		const custom = "You are a custom agent.";
		expect(patchSystemPromptToolSurface(custom, { selectedTools: ["read"] })).toBeUndefined();
	});
});
