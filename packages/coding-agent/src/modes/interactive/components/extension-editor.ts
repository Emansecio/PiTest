/**
 * Multi-line editor component for extensions.
 * Supports Ctrl+G for external editor.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	Container,
	Editor,
	type EditorOptions,
	type Focusable,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
} from "@pit/tui";
import { APP_NAME } from "../../../config.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { getEditorTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

type EditorSpawnPlan = {
	command: string;
	args: string[];
	shell: boolean;
};

/**
 * Build a spawn plan for the external editor without naively space-splitting the
 * command string. A bare value with no spaces is the binary itself (the common case,
 * e.g. "vim", "nano", "code"); on win32 we keep shell:true so .cmd/.bat launchers
 * resolve. A value that contains spaces is ambiguous (it may be a single quoted path,
 * a path with flags, or a path containing spaces), so we hand the raw string to the
 * shell and append the quoted tmpFile — letting the shell tokenize exactly as the
 * user intended their $VISUAL/$EDITOR value to be parsed, rather than guessing here.
 */
function resolveEditorSpawn(editorCmd: string, tmpFile: string): EditorSpawnPlan {
	const trimmed = editorCmd.trim();
	if (!trimmed.includes(" ")) {
		// Single token: it is the binary. Do not split; pass tmpFile as the only arg.
		return {
			command: trimmed,
			args: [tmpFile],
			shell: process.platform === "win32",
		};
	}
	// Contains spaces: run through the shell so the user's command string is tokenized
	// by the shell (preserving quoted/spaced paths). Quote the tmpFile we append; the
	// generated tmp path is a Date.now()-suffixed name under os.tmpdir() with no quotes.
	const quotedTmp = process.platform === "win32" ? `"${tmpFile}"` : `'${tmpFile}'`;
	return {
		command: `${trimmed} ${quotedTmp}`,
		args: [],
		shell: true,
	};
}

export class ExtensionEditorComponent extends Container implements Focusable {
	private editor: Editor;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private keybindings: KeybindingsManager;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		tui: TUI,
		keybindings: KeybindingsManager,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: EditorOptions,
	) {
		super();

		this.tui = tui;
		this.keybindings = keybindings;
		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add title
		this.addChild(new Text(theme.fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));

		// Create editor
		this.editor = new Editor(tui, getEditorTheme(), options);
		if (prefill) {
			this.editor.setText(prefill);
		}
		// Wire up Enter to submit (Shift+Enter for newlines, like the main editor)
		this.editor.onSubmit = (text: string) => {
			this.onSubmitCallback(text);
		};
		this.addChild(this.editor);

		this.addChild(new Spacer(1));

		// Add hint
		const hasExternalEditor = !!(process.env.VISUAL || process.env.EDITOR);
		const hint =
			keyHint("tui.select.confirm", "submit") +
			"  " +
			keyHint("tui.input.newLine", "newline") +
			"  " +
			keyHint("tui.select.cancel", "cancel") +
			(hasExternalEditor ? `  ${keyHint("app.editor.external", "external editor")}` : "");
		this.addChild(new Text(hint, 1, 0));

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Escape or Ctrl+C to cancel
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}

		// External editor (app keybinding)
		if (this.keybindings.matches(keyData, "app.editor.external")) {
			this.openExternalEditor();
			return;
		}

		// Forward to editor
		this.editor.handleInput(keyData);
	}

	private async openExternalEditor(): Promise<void> {
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			return;
		}

		const currentText = this.editor.getText();
		const tmpFile = path.join(os.tmpdir(), `pi-extension-editor-${Date.now()}.md`);

		let stopped = false;
		try {
			fs.writeFileSync(tmpFile, currentText, "utf-8");
			this.tui.stop();
			stopped = true;

			process.stdout.write(
				`Launching external editor: ${editorCmd}\n${APP_NAME} will resume when the editor exits.\n`,
			);

			// Resolve the command/args without naively splitting on spaces, which would
			// break editor paths that contain spaces (e.g. the very common Windows value
			// "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd"). A space-split there
			// yields argv[0]="C:\\Program" and the spawn fails, silently dropping the edit.
			const spawnPlan = resolveEditorSpawn(editorCmd, tmpFile);

			// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
			// Node/libuv's console input read active after tui.stop() pauses stdin, racing
			// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
			const status = await new Promise<number | null>((resolve) => {
				const child = spawn(spawnPlan.command, spawnPlan.args, {
					stdio: "inherit",
					shell: spawnPlan.shell,
				});
				child.on("error", () => resolve(null));
				child.on("close", (code) => resolve(code));
			});

			if (status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
		} finally {
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}
			// Only restart the TUI if it was actually stopped. If writeFileSync
			// threw before tui.stop(), the TUI is still running and a second
			// start() would double-register stdout/stdin listeners (every
			// keystroke handled twice + leaked listeners for the rest of the session).
			if (stopped) {
				this.tui.start();
				// Force full re-render since external editor uses alternate screen
				this.tui.requestRender(true);
			}
		}
	}
}
