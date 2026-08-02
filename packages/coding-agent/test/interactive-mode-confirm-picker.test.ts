/**
 * `confirm` mode end to end through the interactive TUI.
 *
 * `permissions-confirm.test.ts` covers the checker and the gate against a stub
 * bus listener. This exercises the surface the user actually touches: the real
 * permissions extension raises the deferral, the real `UserInputBus` reaches the
 * real `InteractiveMode`, and the real `createAskPicker` is driven with real
 * keystrokes through the TUI input path.
 */

import { setKeybindings } from "@pit/tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPermissionsExtension } from "../src/core/built-ins/permissions-extension.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { PermissionChecker } from "../src/core/permissions/checker.ts";
import {
	CONFIRM_ALLOW_ONCE_LABEL,
	CONFIRM_ALLOW_SESSION_LABEL,
	CONFIRM_DENY_LABEL,
} from "../src/core/permissions/confirm-gate.ts";
import { createInteractiveHarness, type InteractiveHarness } from "./interactive-harness.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";

const cwd = process.platform === "win32" ? "C:/proj" : "/proj";

let harness: InteractiveHarness | undefined;

beforeAll(() => {
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	harness?.dispose();
	harness = undefined;
});

/** Minimal extension host: enough to register the `tool_call` gate and fire it. */
function makeGate(checker: PermissionChecker) {
	const handlers: Array<(event: any) => unknown> = [];
	const blocked: unknown[] = [];
	const api = {
		on(event: string, handler: (e: any) => unknown) {
			if (event === "tool_call") handlers.push(handler);
		},
		registerTool: () => {},
		registerCommand: () => {},
		sendMessage: (m: unknown) => blocked.push(m),
		getOrchestration: () => "solo" as const,
		setOrchestration: () => {},
	} as unknown as ExtensionAPI;
	createPermissionsExtension({ cwd, checker })(api);
	/** Resolves to `undefined` when the call is allowed to run, or the block verdict. */
	const call = async (toolName: string, input: Record<string, unknown>) => {
		for (const handler of handlers) {
			const r = await handler({ toolName, toolCallId: "t1", input });
			if (r !== undefined) return r as { block: true; reason: string };
		}
		return undefined;
	};
	return { call, blocked };
}

/** Real mode + real bus (the harness skips `init()`, which normally binds it). */
function boot(): InteractiveHarness {
	const h = createInteractiveHarness();
	harness = h;
	h.internals().bindUserInputBus();
	return h;
}

function confirmChecker(settings: Record<string, unknown> = {}) {
	return new PermissionChecker({ cwd, mode: "confirm", settings });
}

describe("confirm mode picker (real TUI)", () => {
	it("a write raises the picker with Deny / Allow once / Allow for session", async () => {
		const h = boot();
		const checker = confirmChecker();
		const gate = makeGate(checker);

		const pending = gate.call("write", { path: "src/x.ts", content: "y" });

		const screen = h.editorText();
		expect(screen).toContain("confirm mode");
		expect(screen).toContain("src/x.ts");
		expect(screen).toContain(CONFIRM_DENY_LABEL);
		expect(screen).toContain(CONFIRM_ALLOW_ONCE_LABEL);
		expect(screen).toContain(CONFIRM_ALLOW_SESSION_LABEL);
		// Fail-closed ordering: Deny is the row the cursor starts on.
		expect(screen.indexOf(CONFIRM_DENY_LABEL)).toBeLessThan(screen.indexOf(CONFIRM_ALLOW_ONCE_LABEL));

		h.sendKey(ENTER); // Deny
		await pending;
	});

	it("Deny blocks the call with a reason and remembers nothing", async () => {
		const h = boot();
		const checker = confirmChecker();
		const gate = makeGate(checker);

		const pending = gate.call("write", { path: "src/x.ts", content: "y" });
		h.sendKey(ENTER); // Deny is row 0
		const verdict = await pending;

		expect(verdict).toMatchObject({ block: true });
		expect(verdict?.reason).toContain("User denied");
		expect(checker.settings.allowPaths ?? []).toHaveLength(0);
		// Picker torn down, composer slot handed back.
		expect(h.editorText()).not.toContain(CONFIRM_ALLOW_SESSION_LABEL);
	});

	it("Allow once lets the tool run and keeps asking next time", async () => {
		const h = boot();
		const checker = confirmChecker();
		const gate = makeGate(checker);

		const first = gate.call("write", { path: "src/x.ts", content: "y" });
		h.sendKey(DOWN); // → Allow once
		h.sendKey(ENTER);
		expect(await first).toBeUndefined(); // not blocked → the tool runs
		expect(checker.settings.allowPaths ?? []).toHaveLength(0);

		// Same path again: still a prompt.
		const second = gate.call("write", { path: "src/x.ts", content: "z" });
		expect(h.editorText()).toContain(CONFIRM_ALLOW_ONCE_LABEL);
		h.sendKey(ENTER); // Deny it, just to settle
		expect(await second).toMatchObject({ block: true });
	});

	it("Allow for session records the rule and the SECOND write on that path never asks", async () => {
		const h = boot();
		const checker = confirmChecker();
		const gate = makeGate(checker);

		const first = gate.call("write", { path: "src/x.ts", content: "y" });
		// Focusing the row reveals the rule the grant would record (only the
		// focused option renders its description).
		h.sendKey(DOWN);
		h.sendKey(DOWN);
		expect(h.editorText()).toContain("allowPaths");
		h.sendKey("s"); // declared hotkey for "Allow for session"
		expect(await first).toBeUndefined();
		expect(checker.settings.allowPaths?.map((r) => r.glob)).toEqual([`${cwd}/src/x.ts`]);

		const second = gate.call("write", { path: "src/x.ts", content: "z" });
		// No picker was raised at all — the composer slot is untouched.
		expect(h.editorText()).not.toContain(CONFIRM_ALLOW_SESSION_LABEL);
		expect(h.internals().pendingAskRequest).toBeUndefined();
		expect(await second).toBeUndefined();
	});

	it("Esc denies the call (cancel is fail-closed)", async () => {
		const h = boot();
		const gate = makeGate(confirmChecker());

		const pending = gate.call("bash", { command: "git push origin main" });
		expect(h.editorText()).toContain("git push origin main");
		h.sendKey("\x1b");
		const verdict = await pending;
		expect(verdict).toMatchObject({ block: true });
		expect(verdict?.reason).toContain("cancelled");
	});

	it("a parallel batch of mutations prompts once per call, in order, with a queue badge", async () => {
		const h = boot();
		const checker = confirmChecker();
		const gate = makeGate(checker);

		// The <confirm_mode> steer asks the model to batch; the queue is the
		// defence for when it does not. Both calls must reach the user.
		const first = gate.call("write", { path: "src/a.ts", content: "1" });
		const second = gate.call("write", { path: "src/b.ts", content: "2" });

		expect(h.editorText()).toContain("src/a.ts");
		expect(h.editorText()).toContain("+1 queued");
		expect(h.editorText()).not.toContain("src/b.ts");

		h.sendKey("a"); // Allow once → runs
		expect(await first).toBeUndefined();

		// The second is NOT auto-denied by the collision any more.
		expect(h.editorText()).toContain("src/b.ts");
		expect(h.editorText()).not.toContain("queued");
		h.sendKey(ENTER); // Deny this one
		expect(await second).toMatchObject({ block: true });
	});
});
