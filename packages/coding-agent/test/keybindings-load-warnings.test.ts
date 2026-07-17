import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getKeybindingsLoadWarnings, KeybindingsManager } from "../src/core/keybindings.js";

describe("keybindings load warnings", () => {
	const tempDirs: string[] = [];

	beforeEach(() => {
		resetRuntimeDiagnostics();
	});

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function createAgentDir(raw: string): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-keybindings-warn-"));
		tempDirs.push(dir);
		fs.writeFileSync(path.join(dir, "keybindings.json"), raw, "utf-8");
		return dir;
	}

	function diagnosticNotes(): string[] {
		return getRuntimeDiagnostics()
			.recent.filter((e) => e.source === "keybindings.load")
			.map((e) => e.context?.note ?? "");
	}

	it("surfaces a JSON parse error (and routes it to runtime-diagnostics)", () => {
		const dir = createAgentDir("{ not valid json");
		KeybindingsManager.create(dir);

		const warnings = getKeybindingsLoadWarnings();
		expect(warnings.some((w) => w.includes("Invalid JSON in keybindings.json"))).toBe(true);
		expect(diagnosticNotes().some((n) => n.includes("Invalid JSON"))).toBe(true);
	});

	it("warns about a dropped malformed entry with a reason", () => {
		const dir = createAgentDir(JSON.stringify({ "app.interrupt": 123 }));
		KeybindingsManager.create(dir);

		const warnings = getKeybindingsLoadWarnings();
		expect(warnings.some((w) => w.includes('Ignoring keybinding "app.interrupt"'))).toBe(true);
	});

	it("detects a conflict when two actions claim the same key", () => {
		const dir = createAgentDir(JSON.stringify({ "app.interrupt": "ctrl+j", "app.clear": "ctrl+j" }));
		KeybindingsManager.create(dir);

		const warnings = getKeybindingsLoadWarnings();
		expect(warnings.some((w) => w.includes("Keybinding conflict") && w.includes("ctrl+j"))).toBe(true);
	});

	it("produces no warnings for a clean config", () => {
		const dir = createAgentDir(JSON.stringify({ "app.interrupt": "ctrl+j" }));
		KeybindingsManager.create(dir);

		expect(getKeybindingsLoadWarnings()).toEqual([]);
	});

	it("clears stale warnings on reload of a now-valid file", () => {
		const dir = createAgentDir("{ broken");
		const manager = KeybindingsManager.create(dir);
		expect(getKeybindingsLoadWarnings().length).toBeGreaterThan(0);

		fs.writeFileSync(path.join(dir, "keybindings.json"), JSON.stringify({ "app.interrupt": "ctrl+j" }), "utf-8");
		manager.reload();
		expect(getKeybindingsLoadWarnings()).toEqual([]);
	});
});
