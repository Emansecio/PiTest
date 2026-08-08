import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	EXTERNAL_EDITOR_TEMP_FILE_MODE,
	externalEditorExitMessage,
	resolveEditorSpawn,
	writeExternalEditorTempFile,
} from "../src/modes/interactive/components/extension-editor.ts";

describe("resolveEditorSpawn", () => {
	it("passes a bare editor and temp file without shell tokenization", () => {
		const plan = resolveEditorSpawn("vim", "/tmp/prompt.md");
		expect(plan).toEqual({
			command: "vim",
			args: ["/tmp/prompt.md"],
			shell: false,
		});
	});

	it("parses a quoted executable path and fixed arguments into direct argv", () => {
		const plan = resolveEditorSpawn(
			'"C:/Program Files/Editor/editor.exe" --wait --reuse-window',
			"C:/Temp/prompt.md",
		);
		expect(plan).toEqual({
			command: "C:/Program Files/Editor/editor.exe",
			args: ["--wait", "--reuse-window", "C:/Temp/prompt.md"],
			shell: false,
		});
	});

	it("keeps shell metacharacters and a hostile temp filename as inert arguments", () => {
		const plan = resolveEditorSpawn("vim --cmd 'set title'", "/tmp/prompt;touch PWNED.md");
		expect(plan.command).toBe("vim");
		expect(plan.args).toEqual(["--cmd", "set title", "/tmp/prompt;touch PWNED.md"]);
		expect(plan.shell).toBe(false);
	});

	it("preserves unquoted Windows path backslashes", () => {
		const plan = resolveEditorSpawn(String.raw`C:\Tools\editor.exe --wait`, String.raw`C:\Temp\prompt.md`);
		expect(plan.command).toBe(String.raw`C:\Tools\editor.exe`);
		expect(plan.args).toEqual(["--wait", String.raw`C:\Temp\prompt.md`]);
	});

	it("rejects malformed or empty editor commands", () => {
		expect(() => resolveEditorSpawn('"unterminated', "/tmp/prompt.md")).toThrow(/Unterminated quote/);
		expect(() => resolveEditorSpawn("   ", "/tmp/prompt.md")).toThrow(/executable/);
	});
});

describe("external editor temp prompt", () => {
	it("creates a private prompt file and remains portable on Windows", () => {
		const dir = mkdtempSync(join(tmpdir(), "pit-editor-mode-"));
		const file = join(dir, "prompt.md");
		try {
			writeExternalEditorTempFile(file, "private prompt");
			expect(readFileSync(file, "utf-8")).toBe("private prompt");
			expect(EXTERNAL_EDITOR_TEMP_FILE_MODE).toBe(0o600);
			if (process.platform !== "win32") {
				expect(statSync(file).mode & 0o777).toBe(0o600);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("externalEditorExitMessage", () => {
	it("reports non-zero and missing exit statuses through the application error surface", () => {
		expect(externalEditorExitMessage(0)).toBeUndefined();
		expect(externalEditorExitMessage(7)).toBe("External editor exited with status 7");
		expect(externalEditorExitMessage(null)).toMatch(/without an exit status/);
	});
});
