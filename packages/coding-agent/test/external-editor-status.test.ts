import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { TUI } from "@pit/tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const mocks = vi.hoisted(() => ({ spawnProcess: vi.fn() }));
vi.mock("../src/utils/child-process.ts", () => ({ spawnProcess: mocks.spawnProcess }));

const originalVisual = process.env.VISUAL;
const originalEditor = process.env.EDITOR;

afterEach(() => {
	vi.restoreAllMocks();
	mocks.spawnProcess.mockReset();
	if (originalVisual === undefined) delete process.env.VISUAL;
	else process.env.VISUAL = originalVisual;
	if (originalEditor === undefined) delete process.env.EDITOR;
	else process.env.EDITOR = originalEditor;
});

beforeAll(() => initTheme("dark"));

describe("ExtensionEditorComponent external editor status", () => {
	test("surfaces a non-zero close through its application warning callback", async () => {
		process.env.VISUAL = '"C:/Program Files/Editor/editor.exe" --wait';
		delete process.env.EDITOR;
		const child = new EventEmitter() as ChildProcess;
		mocks.spawnProcess.mockImplementation(() => {
			queueMicrotask(() => child.emit("close", 9));
			return child;
		});
		const tui = {
			stop: vi.fn(),
			start: vi.fn(),
			requestRender: vi.fn(),
		} as unknown as TUI;
		const onError = vi.fn();
		const component = new ExtensionEditorComponent(
			tui,
			new KeybindingsManager({}),
			"Edit",
			"draft",
			vi.fn(),
			vi.fn(),
			undefined,
			onError,
		);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await (component as unknown as { openExternalEditor(): Promise<void> }).openExternalEditor();

		expect(onError).toHaveBeenCalledWith("External editor exited with status 9");
		expect(mocks.spawnProcess).toHaveBeenCalledWith(
			"C:/Program Files/Editor/editor.exe",
			expect.arrayContaining(["--wait"]),
			expect.objectContaining({ shell: false }),
		);
		expect(tui.start).toHaveBeenCalledOnce();
	});
});
