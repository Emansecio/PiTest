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

		// Provider headers render as dim provider ids inside the SelectorCard frame.
		const stripCardFrame = (line: string) => line.replaceAll("│", "").trim();
		const alphaHeaderIdx = lines.findIndex((line) => stripCardFrame(line) === "alpha");
		const betaHeaderIdx = lines.findIndex((line) => stripCardFrame(line) === "beta");
		expect(alphaHeaderIdx).toBeGreaterThanOrEqual(0);
		expect(betaHeaderIdx).toBeGreaterThanOrEqual(0);
		expect(alphaHeaderIdx).toBeLessThan(betaHeaderIdx);

		// The current model is the selected (→) line and sits under the alpha header.
		const selectedLine = lines.find((line) => line.includes("→"));
		expect(selectedLine).toContain("Alpha One");

		// Provider block is contiguous: a1, a2 (both alpha) come before b1 (beta),
		// so a header never splits a provider's models.
		const a1Idx = lines.findIndex((line) => line.includes("Alpha One"));
		const a2Idx = lines.findIndex((line) => line.includes("Alpha Two"));
		const b1Idx = lines.findIndex((line) => line.includes("Beta One"));
		expect(a1Idx).toBeLessThan(a2Idx);
		expect(a2Idx).toBeLessThan(b1Idx);
	});
});
