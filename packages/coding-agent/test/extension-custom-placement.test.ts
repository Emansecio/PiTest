import { Container, Text, type TUI } from "@pit/tui";
import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type Done = (result: undefined) => void;

const showExtensionCustom = Reflect.get(InteractiveMode.prototype, "showExtensionCustom") as (
	this: Record<string, unknown>,
	factory: (tui: TUI, theme: unknown, keybindings: unknown, done: Done) => Text,
	options?: { inlinePlacement?: "replace-editor" | "above-editor" },
) => Promise<undefined>;

function createHost() {
	const editorContainer = new Container();
	const setText = vi.fn();
	const editor = Object.assign(new Text("draft", 0, 0), {
		getText: () => "draft",
		setText,
	});
	editorContainer.addChild(editor);
	const ui = {
		setFocus: vi.fn(),
		requestRender: vi.fn(),
	} as unknown as TUI;
	const host = {
		editorContainer,
		editor,
		ui,
		keybindings: {},
		userWaitMessage: "Waiting for you…",
		beginUserInputWait: vi.fn(() => vi.fn()),
	};
	return { editor, editorContainer, host, setText, ui };
}

async function openCustom(options?: { inlinePlacement?: "replace-editor" | "above-editor" }) {
	const context = createHost();
	const panel = new Text("panel", 0, 0);
	let done: Done | undefined;
	const opened = showExtensionCustom.call(
		context.host,
		(_tui, _theme, _keybindings, close) => {
			done = close;
			return panel;
		},
		options,
	);
	await vi.waitFor(() => expect(context.ui.setFocus).toHaveBeenCalledWith(panel));
	return { ...context, done: () => done?.(undefined), opened, panel };
}

describe("extension custom inline placement", () => {
	test("mounts an opted-in component above the preserved editor", async () => {
		const { done, editor, editorContainer, opened, panel, setText, ui } = await openCustom({
			inlinePlacement: "above-editor",
		});

		expect(editorContainer.children).toEqual([panel, editor]);
		done();
		await opened;

		expect(editorContainer.children).toEqual([editor]);
		expect(setText).toHaveBeenCalledWith("draft");
		expect(ui.setFocus).toHaveBeenLastCalledWith(editor);
	});

	test("keeps replace-editor as the default inline behavior", async () => {
		const { done, editor, editorContainer, opened, panel } = await openCustom();

		expect(editorContainer.children).toEqual([panel]);
		done();
		await opened;
		expect(editorContainer.children).toEqual([editor]);
	});
});
