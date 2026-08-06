import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.js";
import { Editor } from "../src/components/editor.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TUI(new VirtualTerminal(cols, rows));
}

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
	// Default slash/path autocomplete debounce is 40ms.
	await new Promise((resolve) => setTimeout(resolve, 45));
}

const COMMANDS = [
	{ name: "steer", description: "Queue a steering message", argumentHint: "<message>", completeOnly: true },
	{ name: "model", description: "Select model or role", argumentHint: "<model> | <role>" },
	{ name: "compact", description: "Compact the session", argumentHint: "[instructions]" },
	{ name: "clear", description: "Clear the session" },
];

describe("slash autocomplete completeOnly (required argument)", () => {
	it("uses registry priority for browsing while preserving exact matches", async () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "later", description: "later", section: "PROJECT", priority: 20, badge: "extension" },
				{ name: "help", description: "help", section: "ESSENTIAL", priority: 0, badge: "built-in" },
				{ name: "model", description: "model", section: "MODEL", priority: 10, badge: "built-in" },
			],
			process.cwd(),
		);
		const browse = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
		assert.deepEqual(
			browse?.items.map((item) => item.value),
			["help", "model", "later"],
		);
		assert.equal(browse?.items[0]?.section, "ESSENTIAL");
		assert.equal(browse?.items[0]?.badge, "built-in");

		const exact = await provider.getSuggestions(["/later"], 0, 6, { signal: new AbortController().signal });
		assert.equal(exact?.items[0]?.value, "later");
	});

	it("propagates completeOnly from the command declaration, never inferring it from the hint", async () => {
		const provider = new CombinedAutocompleteProvider(COMMANDS, process.cwd());
		const suggestions = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
		assert.ok(suggestions);
		const byName = new Map(suggestions.items.map((item) => [item.value, item]));
		assert.equal(byName.get("steer")?.completeOnly, true, "declared completeOnly must survive into the item");
		assert.equal(
			byName.get("model")?.completeOnly,
			undefined,
			"an angle-bracket hint alone must NOT mark the item (bare /model is a valid invocation)",
		);
		assert.equal(byName.get("compact")?.completeOnly, undefined, "[optional] hint stays submittable");
		assert.equal(byName.get("clear")?.completeOnly, undefined, "no hint stays submittable");
	});

	it("propagates an explicit completeOnly from a plain AutocompleteItem command", async () => {
		const provider = new CombinedAutocompleteProvider(
			[{ value: "custom", label: "custom", completeOnly: true }],
			process.cwd(),
		);
		const suggestions = await provider.getSuggestions(["/cus"], 0, 4, { signal: new AbortController().signal });
		assert.ok(suggestions);
		assert.equal(suggestions.items[0]?.completeOnly, true);
	});

	it("Enter on a completeOnly slash suggestion completes like Tab and does not submit", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, process.cwd()));
		let submitted: string | null = null;
		editor.onSubmit = (text) => {
			submitted = text;
		};

		for (const ch of "/ste") editor.handleInput(ch);
		await flushAutocomplete();
		assert.equal(editor.isShowingAutocomplete(), true);

		editor.handleInput("\r"); // Enter on the highlighted /steer suggestion

		assert.equal(submitted, null, "Enter must not submit a command whose argument is required");
		assert.equal(editor.getText(), "/steer ", "Enter completes the command plus trailing space, like Tab");
		assert.equal(editor.isShowingAutocomplete(), false);
	});

	it("Enter on a submittable slash suggestion still completes and submits", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, process.cwd()));
		let submitted: string | null = null;
		editor.onSubmit = (text) => {
			submitted = text;
		};

		for (const ch of "/cle") editor.handleInput(ch);
		await flushAutocomplete();
		assert.equal(editor.isShowingAutocomplete(), true);

		editor.handleInput("\r");

		assert.equal(submitted, "/clear", "argument-less command keeps the complete-and-submit behavior");
		assert.equal(editor.getText(), "", "submit clears the editor");
	});

	it("Tab behavior on a completeOnly suggestion is unchanged", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, process.cwd()));

		for (const ch of "/ste") editor.handleInput(ch);
		await flushAutocomplete();
		assert.equal(editor.isShowingAutocomplete(), true);

		editor.handleInput("\t");
		assert.equal(editor.getText(), "/steer ");
	});
});
