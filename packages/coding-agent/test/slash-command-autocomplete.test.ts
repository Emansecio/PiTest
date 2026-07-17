import { CombinedAutocompleteProvider } from "@pit/tui";
import { describe, expect, test } from "vitest";

/**
 * The "/" menu threads a command's `argumentHint` into the suggestion
 * description (rendered as "hint — description" by the tui provider). This
 * verifies the contract the interactive builtin mapping relies on end-to-end.
 */
describe("slash-command argument hint plumbing", () => {
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
});
