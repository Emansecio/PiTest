import { setKeybindings } from "@pit/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { FusionSetupComponent, modelRowLabel } from "../../src/modes/interactive/components/fusion-setup.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function fakeModel(id: string, provider: string, name?: string) {
	return {
		id,
		provider,
		name,
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	} as never;
}

function fakeUi() {
	return { requestRender: () => {}, addAnimationCallback: () => () => {} } as never;
}

describe("modelRowLabel", () => {
	it("prefers a distinct registry name", () => {
		expect(modelRowLabel(fakeModel("claude-sonnet-4-6", "anthropic", "Claude Sonnet 4.6"))).toBe("Claude Sonnet 4.6");
	});

	it("falls back to id when name matches", () => {
		expect(modelRowLabel(fakeModel("gpt-4o", "openai-codex", "gpt-4o"))).toBe("gpt-4o");
	});
});

describe("FusionSetupComponent", () => {
	it("shows synth legend and both advisor slots in one card", () => {
		const c = new FusionSetupComponent(
			fakeUi(),
			"claude-opus-4-8",
			[fakeModel("claude-sonnet-4-6", "anthropic", "Claude Sonnet 4.6"), fakeModel("gpt-4o", "openai-codex")],
			{ verify: true, brief: true },
			() => {},
			() => {},
		);
		const text = stripAnsi(c.render(100).join("\n"));
		expect(text).toContain("Fusion setup");
		expect(text).toContain("synth: claude-opus-4-8");
		expect(text).toContain("advisors");
		expect(text).toContain("Claude Sonnet 4.6");
		expect(text).toContain("verify");
		expect(text).toContain("brief");
	});

	it("completes after picking two advisors and reports toggles", () => {
		const onComplete = vi.fn();
		const models = [
			fakeModel("claude-sonnet-4-6", "anthropic", "Claude Sonnet 4.6"),
			fakeModel("gpt-4o", "openai-codex"),
		];
		const c = new FusionSetupComponent(
			fakeUi(),
			"opus",
			models,
			{ verify: true, brief: false },
			onComplete,
			() => {},
		);

		// Toggle brief on (search empty → hotkey)
		c.handleInput("b");
		// Pick first model (Enter)
		c.handleInput("\r");
		// Move to second model and pick
		c.handleInput("j");
		c.handleInput("\r");

		expect(onComplete).toHaveBeenCalledTimes(1);
		const result = onComplete.mock.calls[0][0];
		expect(result.advisors).toHaveLength(2);
		expect(result.verify).toBe(true);
		expect(result.brief).toBe(true);
		expect(result.advisors[0].cli).toBe("claude");
		expect(result.advisors[1].cli).toBe("codex");
	});

	it("filters the list with fuzzy search", () => {
		const c = new FusionSetupComponent(
			fakeUi(),
			"opus",
			[fakeModel("claude-sonnet-4-6", "anthropic", "Claude Sonnet 4.6"), fakeModel("gpt-4o", "openai-codex")],
			{ verify: true, brief: true },
			() => {},
			() => {},
		);
		c.handleInput("g");
		c.handleInput("p");
		c.handleInput("t");
		const text = stripAnsi(c.render(100).join("\n"));
		expect(text).toContain("gpt-4o");
		expect(text).not.toContain("Claude Sonnet 4.6");
	});
});
