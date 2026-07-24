import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, type TUI } from "@pit/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../../../src/utils/ansi.js";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

async function waitForAsyncRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("model selector provider group headers", () => {
	let tempDir: string;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		tempDir = join(tmpdir(), `pi-test-model-selector-headers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("renders a dim header per provider and keeps each provider's block contiguous", async () => {
		// Two custom providers with inline keys so getAvailable() returns exactly
		// these three models (built-ins have no auth → excluded). This gives a
		// controlled provider mix to assert header rendering and grouping.
		const modelsJsonPath = join(tempDir, "models.json");
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					alpha: {
						baseUrl: "https://alpha.example.com/v1",
						apiKey: "k-alpha",
						api: "openai-completions",
						models: [
							{ id: "x", name: "Alpha One" },
							{ id: "zzx", name: "Alpha Two" },
						],
					},
					beta: {
						baseUrl: "https://beta.example.com/v1",
						apiKey: "k-beta",
						api: "openai-completions",
						models: [{ id: "zx", name: "Beta One" }],
					},
				},
			}),
		);

		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		registry.refresh();

		const available = registry.getAvailable();
		const a1 = available.find((m) => m.provider === "alpha" && m.id === "x")!;
		expect(a1).toBeDefined();

		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			a1, // current model → pins alpha block to the top
			settingsManager,
			registry,
			[],
			() => {},
			() => {},
		);

		await waitForAsyncRender();

		const lines = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.map((line) => line.trim());

		// Two-level accordion: each provider is one collapsible group row carrying a
		// `▸`/`▾` disclosure and its model count. Groups open COLLAPSED, so the model
		// rows below only exist once a group is expanded.
		const stripCardFrame = (line: string) => line.replaceAll("│", "").trim();
		const groupIdx = (provider: string) =>
			lines.findIndex((line) => new RegExp(`^[→\\s]*[▸▾]\\s${provider}\\s\\(\\d+\\)`).test(stripCardFrame(line)));
		const alphaHeaderIdx = groupIdx("alpha");
		const betaHeaderIdx = groupIdx("beta");
		expect(alphaHeaderIdx).toBeGreaterThanOrEqual(0);
		expect(betaHeaderIdx).toBeGreaterThanOrEqual(0);
		expect(alphaHeaderIdx).toBeLessThan(betaHeaderIdx);

		// The cursor parks on the group holding the current model, and a COLLAPSED
		// group carrying the current model is marked ✓ so it is findable unexpanded.
		const selectedLine = lines.find((line) => line.includes("→"));
		expect(stripCardFrame(selectedLine ?? "")).toMatch(/^→\s▸\salpha\s\(2\)\s✓$/);

		// Expand alpha (the cursor is already parked on it): its two models must then
		// render contiguously between its own header and the next provider's header —
		// a header never splits a provider's block.
		selector.handleInput(" ");
		await waitForAsyncRender();
		const expanded = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.map((line) => line.trim());
		const a1Idx = expanded.findIndex((line) => line.includes("Alpha One"));
		const a2Idx = expanded.findIndex((line) => line.includes("Alpha Two"));
		const betaAfterIdx = expanded.findIndex((line) => /^[→\s]*[▸▾]\sbeta\s\(\d+\)/.test(stripCardFrame(line)));
		expect(a1Idx).toBeGreaterThanOrEqual(0);
		expect(a1Idx).toBeLessThan(a2Idx);
		expect(a2Idx).toBeLessThan(betaAfterIdx);
		// Beta stays collapsed, so none of its models leak into alpha's block.
		expect(expanded.some((line) => line.includes("Beta One"))).toBe(false);
		// The current model carries the ✓ once its group is open.
		expect(expanded[a1Idx]).toContain("✓");

		// Collapse alpha again so the search assertions below start from the default.
		selector.handleInput(" ");
		await waitForAsyncRender();

		// Fuzzy rank interleaves alpha/x, beta/zx, alpha/zzx. Search results are
		// therefore a flat ranked list with provider names inline, not three noisy
		// group headers (alpha, beta, alpha).
		selector.handleInput("x");
		const searchLines = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.map((line) => line.trim());
		expect(searchLines.filter((line) => stripCardFrame(line) === "alpha")).toHaveLength(0);
		expect(searchLines.filter((line) => stripCardFrame(line) === "beta")).toHaveLength(0);
		expect(searchLines.some((line) => line.includes("alpha · Alpha One"))).toBe(true);
		expect(searchLines.some((line) => line.includes("beta · Beta One"))).toBe(true);
	});
});
