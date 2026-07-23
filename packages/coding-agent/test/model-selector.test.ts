/**
 * Behavioral tests for ModelSelectorComponent — the hand-rolled selector (it
 * keeps section headers for the pinned cycle set + provider groups, so it does
 * not use SelectList/SelectorShell). Covers the two-step Esc, home/end/page
 * navigation, and the enriched detail line (pure formatter + omitted segments).
 *
 * Style follows selector-shell.test.ts / the model-selector regression tests:
 * initTheme("dark"), a fresh KeybindingsManager, stripAnsi over rendered output.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, type TUI } from "@pit/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	dedupeOpencodeEndpoints,
	formatModelDetailLine,
	ModelSelectorComponent,
} from "../src/modes/interactive/components/model-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const ESC = "\x1b";
const END = "\x1b[F";
const DOWN = "\x1b[B";
const SPACE = " ";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

async function waitForAsyncRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("formatModelDetailLine", () => {
	it("renders ctx / reasoning / prices when the model has them", () => {
		const model = {
			provider: "acme",
			id: "sonar-x",
			reasoning: true,
			contextWindow: 200000,
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		} as any;
		expect(formatModelDetailLine(model)).toBe("acme/sonar-x · 200k ctx · ✦ reasoning · $3/$15 per MTok");
	});

	it("formats a 1M context window and sub-dollar prices with sensible precision", () => {
		const model = {
			provider: "p",
			id: "q",
			reasoning: false,
			contextWindow: 1000000,
			cost: { input: 0.25, output: 1.25, cacheRead: 0, cacheWrite: 0 },
		} as any;
		expect(formatModelDetailLine(model)).toBe("p/q · 1M ctx · $0.25/$1.25 per MTok");
	});

	it("omits any missing/zero segment instead of printing undefined/0", () => {
		const model = {
			provider: "acme",
			id: "mini",
			reasoning: false,
			contextWindow: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		} as any;
		expect(formatModelDetailLine(model)).toBe("acme/mini");
	});
});

describe("dedupeOpencodeEndpoints", () => {
	// Minimal ModelItem shapes — the dedup only reads provider/id.
	const item = (provider: string, id: string) => ({ provider, id, model: { provider, id } }) as any;

	it("drops a Go model when the same id exists on Zen, keeping the Zen entry", () => {
		const models = [item("opencode", "deepseek-v4-flash"), item("opencode-go", "deepseek-v4-flash")];
		const result = dedupeOpencodeEndpoints(models);
		expect(result).toHaveLength(1);
		expect(result[0].provider).toBe("opencode");
	});

	it("keeps Go models whose id is not present on Zen", () => {
		const models = [
			item("opencode", "deepseek-v4-flash"),
			item("opencode-go", "deepseek-v4-flash"), // overlap → dropped
			item("opencode-go", "minimax-m3"), // Go-only → kept
		];
		const result = dedupeOpencodeEndpoints(models);
		expect(result.map((m) => `${m.provider}/${m.id}`)).toEqual([
			"opencode/deepseek-v4-flash",
			"opencode-go/minimax-m3",
		]);
	});

	it("leaves a Go-only auth setup (no Zen entries) fully intact", () => {
		const models = [item("opencode-go", "deepseek-v4-flash"), item("opencode-go", "glm-5.2")];
		expect(dedupeOpencodeEndpoints(models)).toEqual(models);
	});

	it("does not collapse unrelated providers that happen to share a model id", () => {
		// Verboo also exposes deepseek-v4-flash under its own key — never touched.
		const models = [item("opencode", "deepseek-v4-flash"), item("verboo", "deepseek-v4-flash")];
		expect(dedupeOpencodeEndpoints(models)).toHaveLength(2);
	});
});

describe("ModelSelectorComponent OpenCode endpoints", () => {
	let tempDir: string;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		tempDir = join(tmpdir(), `pi-test-model-selector-oc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("labels endpoints with friendly names and shows an overlapping model once (Zen wins)", async () => {
		// Both endpoints authed (they share OPENCODE_API_KEY in practice) so both
		// surface. The catalog de-dupe (commit 45bbc4a5a) now keeps overlapping ids
		// only on Zen, so opencode-go no longer ships deepseek-v4-flash built-in.
		// Re-create the duplicate the user reported by adding it back to opencode-go
		// via models.json, so the selector-level collapse (dedupeOpencodeEndpoints)
		// still has an overlap to exercise.
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.set("opencode", { type: "api_key", key: "k" });
		authStorage.set("opencode-go", { type: "api_key", key: "k" });
		const modelsJsonPath = join(tempDir, "models.json");
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"opencode-go": {
						baseUrl: "https://opencode.ai/zen/go/v1",
						apiKey: "OPENCODE_API_KEY",
						api: "openai-completions",
						models: [
							{
								id: "deepseek-v4-flash",
								name: "DeepSeek V4 Flash",
								reasoning: true,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128000,
								maxTokens: 8192,
							},
						],
					},
				},
			}),
		);
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		registry.refresh();

		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			registry.find("opencode", "deepseek-v4-flash")!,
			settingsManager,
			registry,
			[],
			() => {},
			() => {},
		);
		await waitForAsyncRender();

		// Narrow to the overlapping id: exactly one row survives, and it is Zen's.
		selector.handleInput("d");
		selector.handleInput("e");
		selector.handleInput("e");
		selector.handleInput("p");
		selector.handleInput("s");
		selector.handleInput("e");
		selector.handleInput("e");
		selector.handleInput("k");
		selector.handleInput("-");
		selector.handleInput("v");
		selector.handleInput("4");
		const flash = registry.getAvailable().filter((m) => m.id === "deepseek-v4-flash");
		expect(flash.some((m) => m.provider === "opencode")).toBe(true);
		expect(flash.some((m) => m.provider === "opencode-go")).toBe(true); // both available…

		const joined = stripAnsi(selector.render(120).join("\n"));
		// …but the picker shows the friendly Zen header, not the raw id,
		expect(joined).toContain("OpenCode Zen");
		expect(joined).not.toMatch(/^\s*opencode\s*$/m);
		// and the Go duplicate is collapsed away.
		expect(joined).not.toContain("OpenCode Go");
		expect(selector.getSelectedModel()?.provider).toBe("opencode");
	});
});

describe("ModelSelectorComponent navigation & Esc", () => {
	let tempDir: string;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		tempDir = join(tmpdir(), `pi-test-model-selector-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function makeSelector(onCancel: () => void = () => {}): ModelSelectorComponent {
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
							{ id: "a3", name: "Alpha Three" },
							{ id: "a4", name: "Alpha Four" },
							{ id: "a5", name: "Alpha Five" },
						],
					},
				},
			}),
		);

		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		registry.refresh();
		const current = registry.find("alpha", "a1")!;
		expect(current).toBeDefined();

		const settingsManager = SettingsManager.create(tempDir, tempDir);
		return new ModelSelectorComponent(createFakeTui(), current, settingsManager, registry, [], () => {}, onCancel);
	}

	it("expands a group with Space, then navigates its models with arrows/End", async () => {
		const selector = makeSelector();
		await waitForAsyncRender();

		// All groups collapsed on open: the highlighted row is the provider group,
		// so no model is selected yet.
		expect(selector.getSelectedModel()).toBeUndefined();

		// Space expands "alpha"; its models become navigable.
		selector.handleInput(SPACE);
		selector.handleInput(DOWN); // step onto the first model
		expect(selector.getSelectedModel()?.id).toBe("a1");

		selector.handleInput(END);
		expect(selector.getSelectedModel()?.id).toBe("a5");

		// Down from the last row wraps to the group header.
		selector.handleInput(DOWN);
		expect(selector.getSelectedModel()).toBeUndefined();

		// On the group header, Space collapses it again — the models disappear and
		// the cursor stays on the (now collapsed) header.
		selector.handleInput(SPACE);
		expect(selector.getSelectedModel()).toBeUndefined();
		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("Alpha One");
	});

	it("uses a two-step Esc when searching: first clears the query, then closes", async () => {
		let cancelled = 0;
		const selector = makeSelector(() => {
			cancelled++;
		});
		await waitForAsyncRender();

		// Type a query that narrows to a single model.
		selector.handleInput("a");
		selector.handleInput("5");
		expect(selector.getSearchInput().getValue()).toBe("a5");
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Alpha Five");
		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("Alpha One");

		// First Esc: clears the query and re-filters, does NOT close. Cleared search
		// returns to the collapsed accordion — the provider group header is shown,
		// its models stay hidden until expanded.
		selector.handleInput(ESC);
		expect(cancelled).toBe(0);
		expect(selector.getSearchInput().getValue()).toBe("");
		const cleared = stripAnsi(selector.render(120).join("\n"));
		expect(cleared).toContain("alpha");
		expect(cleared).not.toContain("Alpha One");

		// Second Esc (empty query): closes via onCancel.
		selector.handleInput(ESC);
		expect(cancelled).toBe(1);
	});

	it("renders the enriched detail line for the highlighted model", async () => {
		const selector = makeSelector();
		await waitForAsyncRender();

		// A highlighted group shows a count hint, not a model detail line.
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Space to expand");

		// Expand and step onto a model — the detail line leads with provider/id (other
		// segments depend on registry defaults, covered by formatModelDetailLine).
		selector.handleInput(SPACE);
		selector.handleInput(DOWN);
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("alpha/a1");
	});
});
