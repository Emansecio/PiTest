/**
 * The preview tool talks to Chrome over CDP. `settle()` is bounded, but
 * navigate/screenshot had no deadline of their own — a stuck tab or an open
 * native dialog could hold the tool (and with it the whole step boundary)
 * hostage indefinitely (observed: a 12-minute hang). These tests pin the total
 * deadline: a hung CDP call fails the tool with a clear timeout message instead
 * of hanging, and a user abort is still reported as an abort, not a timeout.
 */

import { afterEach, describe, expect, test } from "vitest";
import {
	type ChromeDevtoolsManager,
	setCurrentChromeDevtoolsManager,
} from "../src/core/chrome/chrome-devtools-manager.ts";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createPreviewToolDefinition } from "../src/core/tools/preview.ts";

/** A manager whose navigate hangs forever, honoring only the abort signal. */
function hangingManager(): ChromeDevtoolsManager {
	return {
		navigate: (_input: unknown, signal?: AbortSignal) =>
			new Promise((_resolve, reject) => {
				const onAbort = () => reject(new Error("Request was aborted"));
				if (signal?.aborted) return onAbort();
				signal?.addEventListener("abort", onAbort, { once: true });
			}),
		evaluate: async () => ({ value: "complete" }),
		screenshot: async () => ({ data: "ZGF0YQ==", mimeType: "image/png" }),
		readConsole: () => [],
		readNetwork: () => [],
	} as unknown as ChromeDevtoolsManager;
}

// The preview tool never touches the extension context (same idiom as the
// other tool-definition tests).
const ctx = () => ({}) as ExtensionContext;

afterEach(() => setCurrentChromeDevtoolsManager(undefined));

describe("preview total deadline", () => {
	test("a hung CDP call fails the tool at the deadline instead of hanging forever", async () => {
		setCurrentChromeDevtoolsManager(hangingManager());
		const def = createPreviewToolDefinition(process.cwd(), { totalTimeoutMs: 80 });

		const result = await def.execute("call-1", { target: "http://localhost:9" }, undefined, undefined, ctx());

		expect(result.details.ok).toBe(false);
		expect(result.details.error).toMatch(/timed out/i);
	});

	// getConn's WS connect (inside navigate newTab) cannot observe the signal at
	// all — the deadline must hold even against a call that ignores it entirely.
	test("a CDP call that ignores the abort signal still fails at the deadline", async () => {
		const mgr = hangingManager();
		(mgr as unknown as { navigate: () => Promise<void> }).navigate = () => new Promise(() => {});
		setCurrentChromeDevtoolsManager(mgr);
		const def = createPreviewToolDefinition(process.cwd(), { totalTimeoutMs: 80 });

		const result = await def.execute("call-4", { target: "http://localhost:9" }, undefined, undefined, ctx());

		expect(result.details.ok).toBe(false);
		expect(result.details.error).toMatch(/timed out/i);
	});

	test("a user abort is reported as an abort, not converted into a timeout", async () => {
		setCurrentChromeDevtoolsManager(hangingManager());
		const def = createPreviewToolDefinition(process.cwd(), { totalTimeoutMs: 5_000 });
		const user = new AbortController();
		setTimeout(() => user.abort(), 20);

		const result = await def.execute("call-2", { target: "http://localhost:9" }, user.signal, undefined, ctx());

		expect(result.details.ok).toBe(false);
		expect(result.details.error).not.toMatch(/timed out/i);
	});

	test("a healthy render still succeeds under the deadline", async () => {
		const mgr = hangingManager();
		(mgr as unknown as { navigate: () => Promise<void> }).navigate = async () => {};
		setCurrentChromeDevtoolsManager(mgr);
		const def = createPreviewToolDefinition(process.cwd(), { totalTimeoutMs: 5_000 });

		const result = await def.execute("call-3", { target: "http://localhost:9" }, undefined, undefined, ctx());

		expect(result.details.ok).toBe(true);
	});
});
