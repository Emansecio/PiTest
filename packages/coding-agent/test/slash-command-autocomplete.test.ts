import { CombinedAutocompleteProvider } from "@pit/tui";
import { describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

/**
 * The "/" menu threads a command's `argumentHint` into the suggestion
 * description (rendered as "hint — description" by the tui provider). This
 * verifies the contract the interactive builtin mapping relies on end-to-end.
 */
describe("slash-command argument hint plumbing", () => {
	const sourceInfo = (path: string) => ({
		path,
		source: "local",
		scope: "project" as const,
		origin: "top-level" as const,
	});
	async function suggest(commands: ConstructorParameters<typeof CombinedAutocompleteProvider>[0], text: string) {
		const provider = new CombinedAutocompleteProvider(commands, process.cwd(), null);
		return provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal });
	}

	test("argumentHint prefixes the suggestion description", async () => {
		const result = await suggest(
			[{ name: "compact", description: "Manually compact the session context", argumentHint: "[instructions]" }],
			"/comp",
		);
		expect(result).not.toBeNull();
		const item = result?.items.find((i) => i.value === "compact");
		expect(item?.description).toContain("[instructions]");
		expect(item?.description).toContain("Manually compact");
	});

	test("a command without a hint shows only its description", async () => {
		const result = await suggest([{ name: "session", description: "Show session info" }], "/sess");
		const item = result?.items.find((i) => i.value === "session");
		expect(item?.description).toBe("Show session info");
	});

	test("keeps collision-renamed extensions and matches runtime precedence", async () => {
		const createBaseAutocompleteProvider = Reflect.get(
			InteractiveMode.prototype,
			"createBaseAutocompleteProvider",
		) as () => CombinedAutocompleteProvider;
		const fakeThis = {
			session: {
				promptTemplates: [
					{ name: "help", description: "shadowed template", sourceInfo: sourceInfo("help.md") },
					{ name: "review", description: "shadowed template", sourceInfo: sourceInfo("review.md") },
				],
				extensionRunner: {
					getRegisteredCommands: () => [
						{
							name: "help",
							invocationName: "help:2",
							description: "Second help command",
							sourceInfo: sourceInfo("extension.ts"),
						},
					],
				},
				resourceLoader: {
					getSkills: () => ({
						skills: [
							{
								name: "review",
								description: "Review changes",
								filePath: "review.md",
								sourceInfo: sourceInfo("review.md"),
							},
						],
					}),
				},
				scopedModels: [],
				modelRegistry: { getAvailable: () => [], filterScopedModels: () => [] },
			},
			settingsManager: { getEnableSkillCommands: () => true },
			skillCommands: new Map(),
			sessionManager: { getCwd: () => process.cwd() },
			fdPath: null,
		};

		const provider = createBaseAutocompleteProvider.call(fakeThis as never);
		const result = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
		const values = result?.items.map((item) => item.value) ?? [];

		expect(values).toContain("help:2");
		expect(values).toContain("review");
		expect(values.filter((value) => value === "review")).toHaveLength(1);
	});
});
