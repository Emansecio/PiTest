import { describe, expect, it } from "vitest";
import { type EngineeringStyle, getEngineeringStyleGuidelines } from "../src/core/engineering-styles.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

describe("getEngineeringStyleGuidelines", () => {
	it("returns an empty list for default", () => {
		expect(getEngineeringStyleGuidelines("default")).toEqual([]);
	});

	it("returns 4 bullets covering the four Karpathy principles", () => {
		const bullets = getEngineeringStyleGuidelines("karpathy");
		expect(bullets).toHaveLength(4);
		const joined = bullets.join("\n").toLowerCase();
		expect(joined).toContain("assumption");
		expect(joined).toContain("simplicity");
		expect(joined).toContain("surgical");
		expect(joined).toContain("verifiable");
	});

	it("falls back to empty for an unknown style", () => {
		expect(getEngineeringStyleGuidelines("unknown" as EngineeringStyle)).toEqual([]);
	});

	it("bullets are non-empty and trimmed", () => {
		for (const b of getEngineeringStyleGuidelines("karpathy")) {
			expect(b.trim()).toBe(b);
			expect(b.length).toBeGreaterThan(20);
		}
	});
});

describe("SettingsManager.getEngineeringStyle", () => {
	it('defaults to "karpathy"', () => {
		const sm = SettingsManager.inMemory();
		expect(sm.getEngineeringStyle()).toBe("karpathy");
	});

	it('returns "karpathy" when configured', () => {
		const sm = SettingsManager.inMemory({ engineeringStyle: "karpathy" });
		expect(sm.getEngineeringStyle()).toBe("karpathy");
	});

	it('returns "default" when explicitly set', () => {
		const sm = SettingsManager.inMemory({ engineeringStyle: "default" });
		expect(sm.getEngineeringStyle()).toBe("default");
	});

	it('treats unknown values as "karpathy"', () => {
		const sm = SettingsManager.inMemory({ engineeringStyle: "anarchist" as EngineeringStyle });
		expect(sm.getEngineeringStyle()).toBe("karpathy");
	});
});

describe("buildSystemPrompt consumes karpathy guidelines via promptGuidelines", () => {
	it("includes all karpathy bullets verbatim in the Guidelines section", () => {
		const prompt = buildSystemPrompt({
			cwd: "/tmp/proj",
			selectedTools: ["read"],
			toolSnippets: { read: "read a file" },
			promptGuidelines: getEngineeringStyleGuidelines("karpathy"),
		});
		for (const b of getEngineeringStyleGuidelines("karpathy")) {
			expect(prompt).toContain(b);
		}
	});

	it("default style adds no extra bullets compared to baseline", () => {
		const baseOptions = {
			cwd: "/tmp/proj",
			selectedTools: ["read"],
			toolSnippets: { read: "read a file" },
		};
		const baseline = buildSystemPrompt(baseOptions);
		const withDefault = buildSystemPrompt({
			...baseOptions,
			promptGuidelines: getEngineeringStyleGuidelines("default"),
		});
		expect(withDefault).toBe(baseline);
	});

	it("karpathy guidelines extend the default Guidelines section, not replace it", () => {
		const baseOptions = {
			cwd: "/tmp/proj",
			selectedTools: ["read"],
			toolSnippets: { read: "read a file" },
		};
		const baseline = buildSystemPrompt(baseOptions);
		const enriched = buildSystemPrompt({
			...baseOptions,
			promptGuidelines: getEngineeringStyleGuidelines("karpathy"),
		});
		expect(enriched.length).toBeGreaterThan(baseline.length);
		// Baseline guidelines must survive alongside the karpathy bullets.
		// PiTuned tweaks renamed some baseline bullets; pick stable ones still in tree.
		expect(enriched).toContain("Show file paths clearly");
	});
});
