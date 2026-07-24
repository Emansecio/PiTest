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

describe("model selector error banner", () => {
	let tempDir: string;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		tempDir = join(tmpdir(), `pi-test-model-selector-err-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("shows available models alongside (not instead of) a models.json error", async () => {
		// Invalid models.json: `providers` must be a record, not a number. This sets
		// getError() but built-in models still load (see ModelRegistry.buildModels).
		const modelsJsonPath = join(tempDir, "models.json");
		writeFileSync(modelsJsonPath, JSON.stringify({ providers: 123 }));

		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.set("anthropic", { type: "api_key", key: "k" });

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		registry.refresh();
		expect(registry.getError()).toBeDefined();
		expect(registry.getAvailable().some((m) => m.provider === "anthropic")).toBe(true);

		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			settingsManager,
			registry,
			[],
			() => {},
			() => {},
		);

		await waitForAsyncRender();

		const rendered = stripAnsi(selector.render(120).join("\n"));

		// The list must still offer the anthropic models. Under the two-level
		// accordion they sit behind one collapsed group row carrying the provider's
		// display label and its count — the models themselves appear once it opens.
		expect(rendered).toMatch(/[▸▾]\s.*Claude.*\(\d+\)/);
		// …AND the error must surface as a banner (regression: it used to replace the list).
		expect(rendered).toContain("Invalid models.json schema");

		// Open the group (the cursor is parked on it) and confirm real model rows are
		// listed ALONGSIDE the banner, not instead of it — the actual regression.
		selector.handleInput(" ");
		await waitForAsyncRender();
		const expanded = stripAnsi(selector.render(120).join("\n"));
		expect(expanded).toMatch(/claude/i);
		expect(expanded).toContain("Invalid models.json schema");
	});
});
