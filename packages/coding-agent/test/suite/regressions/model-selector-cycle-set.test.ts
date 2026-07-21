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

describe("model selector cycle set", () => {
	let tempDir: string;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		tempDir = join(tmpdir(), `pi-test-model-selector-cycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("pins the --models cycle set at the top and lists the rest without a scope toggle", async () => {
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
							{ id: "a1", name: "Alpha One" },
							{ id: "a2", name: "Alpha Two" },
						],
					},
					beta: {
						baseUrl: "https://beta.example.com/v1",
						apiKey: "k-beta",
						api: "openai-completions",
						models: [{ id: "b1", name: "Beta One" }],
					},
				},
			}),
		);

		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		registry.refresh();

		const available = registry.getAvailable();
		const a1 = available.find((m) => m.provider === "alpha" && m.id === "a1")!;
		const b1 = available.find((m) => m.provider === "beta" && m.id === "b1")!;
		expect(a1).toBeDefined();
		expect(b1).toBeDefined();

		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			a1,
			settingsManager,
			registry,
			[{ model: b1 }],
			() => {},
			() => {},
		);

		await waitForAsyncRender();

		const lines = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.map((line) => line.trim());

		expect(lines.some((line) => line.includes("Cycle set"))).toBe(true);
		expect(lines.filter((line) => line.includes("Cycle set"))).toHaveLength(1);
		expect(lines.some((line) => line.includes("1 model in cycle"))).toBe(true);
		expect(lines).not.toContain("Scope:");
		expect(lines).not.toContain("all | enabled");

		// SelectorCard frames list rows; section headers are substring matches, not bare lines.
		const cycleSectionIdx = lines.findIndex((line) => line.includes("● Cycle set"));
		const allHeaderIdx = lines.findIndex((line) => line.includes("All models"));
		const b1Idx = lines.findIndex((line) => line.includes("Beta One"));
		const a2Idx = lines.findIndex((line) => line.includes("Alpha Two"));

		expect(cycleSectionIdx).toBeGreaterThanOrEqual(0);
		expect(allHeaderIdx).toBeGreaterThan(cycleSectionIdx);
		expect(b1Idx).toBeGreaterThan(cycleSectionIdx);
		expect(b1Idx).toBeLessThan(allHeaderIdx);
		expect(a2Idx).toBeGreaterThan(allHeaderIdx);
		expect(lines.some((line) => line.includes("[beta]"))).toBe(false);
		expect(lines.some((line) => line.includes("alpha/a1"))).toBe(true);
	});

	it("excludes scoped models without configured auth from the cycle set", async () => {
		const modelsJsonPath = join(tempDir, "models.json");
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					alpha: {
						baseUrl: "https://alpha.example.com/v1",
						apiKey: "k-alpha",
						api: "openai-completions",
						models: [{ id: "a1", name: "Alpha One" }],
					},
				},
			}),
		);

		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		registry.refresh();

		const a1 = registry.find("alpha", "a1")!;
		const unauthed = {
			id: "ghost",
			name: "Ghost Model",
			provider: "ghost-provider",
			api: "openai-completions" as const,
			baseUrl: "https://ghost.example.com/v1",
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		expect(registry.hasConfiguredAuth(a1)).toBe(true);
		expect(registry.hasConfiguredAuth(unauthed)).toBe(false);

		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			a1,
			settingsManager,
			registry,
			[{ model: unauthed }, { model: a1 }],
			() => {},
			() => {},
		);

		await waitForAsyncRender();

		const lines = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.map((line) => line.trim());

		expect(lines.some((line) => line.includes("Cycle set"))).toBe(true);
		expect(lines.some((line) => line.includes("Alpha One"))).toBe(true);
		expect(lines.some((line) => line.includes("Ghost Model"))).toBe(false);
		expect(lines.some((line) => line.includes("ghost-provider"))).toBe(false);
	});
});
