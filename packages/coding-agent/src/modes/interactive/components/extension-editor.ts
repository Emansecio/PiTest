/**
 * Multi-line editor component for extensions.
 * Supports Ctrl+G for external editor.
 */

import { randomUUID } from "node:crypto";
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
import { spawnProcess } from "../../../utils/child-process.ts";
import { getEditorTheme, theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { SelectorCard } from "./selector-card.ts";

export type EditorSpawnPlan = {
	command: string;
	args: string[];
	shell: false;
};

/**
 * Tokenize $VISUAL/$EDITOR without invoking a shell. Quoted executable paths and
 * fixed editor arguments are supported, while shell metacharacters remain ordinary
 * argv data. Backslashes are preserved for Windows paths unless they escape a quote,
 * whitespace, or another backslash.
 */
function parseEditorCommand(command: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let tokenStarted = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		if (quote) {
			if (char === quote) {
				quote = undefined;
				tokenStarted = true;
			} else if (char === "\\" && quote === '"' && /["\\]/.test(command[i + 1] ?? "")) {
				current += command[++i]!;
				tokenStarted = true;
			} else {
				current += char;
				tokenStarted = true;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			tokenStarted = true;
		} else if (/\s/.test(char)) {
			if (tokenStarted) {
				args.push(current);
				current = "";
				tokenStarted = false;
			}
		} else if (char === "\\" && /[\s'"\\]/.test(command[i + 1] ?? "")) {
			current += command[++i]!;
			tokenStarted = true;
		} else {
			current += char;
			tokenStarted = true;
		}
	}
	if (quote) throw new Error("Unterminated quote in $VISUAL/$EDITOR");
	if (tokenStarted) args.push(current);
	if (!args[0]) throw new Error("$VISUAL/$EDITOR does not name an executable");
	return args;
}

/** Build a direct-spawn plan. cross-spawn handles Windows .cmd/.bat resolution. */
export function resolveEditorSpawn(editorCmd: string, tmpFile: string): EditorSpawnPlan {
	const [command, ...editorArgs] = parseEditorCommand(editorCmd.trim());
	return { command: command!, args: [...editorArgs, tmpFile], shell: false };
}

export function externalEditorExitMessage(status: number | null): string | undefined {
	if (status === 0) return undefined;
	return status === null
		? "External editor terminated without an exit status"
		: `External editor exited with status ${status}`;
}

export const EXTERNAL_EDITOR_TEMP_FILE_MODE = 0o600;

/** Create a prompt file private to the current user. The mode option is safely ignored on Windows. */
export function writeExternalEditorTempFile(filePath: string, content: string): void {
	fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: EXTERNAL_EDITOR_TEMP_FILE_MODE });
}

export class ExtensionEditorComponent extends Container implements Focusable {
	private editor: Editor;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private keybindings: KeybindingsManager;
	private onErrorCallback?: (message: string) => void;

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
		onError?: (message: string) => void,
	) {
		super();

		this.tui = tui;
		this.keybindings = keybindings;
		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;
		this.onErrorCallback = onError;

		const card = new SelectorCard();
		card.addChild(new Spacer(1));

		// Add title
		card.addChild(new Text(theme.fg("accent", title), 1, 0));
		card.addChild(new Spacer(1));

		// Create editor
		this.editor = new Editor(tui, getEditorTheme(), options);
		if (prefill) {
			this.editor.setText(prefill);
		}
		// Wire up Enter to submit (Shift+Enter for newlines, like the main editor)
		this.editor.onSubmit = (text: string) => {
			this.onSubmitCallback(text);
		};
		card.addChild(this.editor);

		card.addChild(new Spacer(1));

		// Add hint
		const hasExternalEditor = !!(process.env.VISUAL || process.env.EDITOR);
		const hint =
			keyHint("tui.select.confirm", "submit") +
			"  " +
			keyHint("tui.input.newLine", "newline") +
			"  " +
			keyHint("tui.select.cancel", "cancel") +
			(hasExternalEditor ? `  ${keyHint("app.editor.external", "external editor")}` : "");
		card.addChild(new Text(hint, 1, 0));

		card.addChild(new Spacer(1));
		this.addChild(card);
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
		const tmpFile = path.join(os.tmpdir(), `pi-extension-editor-${randomUUID()}.md`);

		let stopped = false;
		try {
			writeExternalEditorTempFile(tmpFile, currentText);
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
			let spawnError: Error | undefined;
			const status = await new Promise<number | null>((resolve) => {
				const child = spawnProcess(spawnPlan.command, spawnPlan.args, {
					stdio: "inherit",
					shell: spawnPlan.shell,
				});
				child.on("error", (error) => {
					spawnError = error;
					resolve(null);
				});
				child.on("close", (code) => resolve(code));
			});

			if (status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			} else {
				this.onErrorCallback?.(
					spawnError ? `External editor failed: ${spawnError.message}` : externalEditorExitMessage(status)!,
				);
			}
		} catch (error) {
			this.onErrorCallback?.(`External editor failed: ${(error as Error).message}`);
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
