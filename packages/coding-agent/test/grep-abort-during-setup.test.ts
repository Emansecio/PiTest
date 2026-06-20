/**
 * Regression for #18: grep dropped an AbortSignal that fired DURING the
 * setup awaits (ensureTool("rg") / ops.isDirectory). The abort listener is only
 * registered after those awaits, and addEventListener({once:true}) does not
 * replay an abort that already fired — so an ESC mid-setup was lost: `aborted`
 * stayed false, ripgrep ran to completion, and the close handler resolved
 * normally instead of rejecting.
 *
 * The fix re-checks `signal?.aborted` right after the awaits. We exercise the
 * window by injecting a custom `isDirectory` that aborts the signal while it is
 * running (i.e. before the listener is attached), then assert the operation
 * rejects with "Operation aborted".
 */

import { describe, expect, it } from "vitest";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";

describe("grep: abort during setup awaits is honored (#18)", () => {
	it("rejects when the signal aborts while isDirectory is awaiting (listener not yet attached)", async () => {
		const controller = new AbortController();
		let isDirectoryCalled = false;
		let readFileCalled = false;

		const def = createGrepToolDefinition(process.cwd(), {
			operations: {
				isDirectory: async () => {
					isDirectoryCalled = true;
					// Abort while this await is in flight — exactly the window where the
					// real onAbort listener is not yet registered. Resolve afterwards so
					// the post-await re-check is what must catch the abort.
					controller.abort();
					await new Promise((r) => setTimeout(r, 5));
					return true;
				},
				readFile: async () => {
					readFileCalled = true;
					return "";
				},
			},
		});

		const ctx = {} as Parameters<typeof def.execute>[4];
		await expect(
			def.execute("grep-abort", { pattern: "anything", path: "." }, controller.signal, undefined, ctx),
		).rejects.toThrow(/abort/i);

		// Proves the abort was caught in the setup window: isDirectory ran, but the
		// search never proceeded to read/format files.
		expect(isDirectoryCalled).toBe(true);
		expect(readFileCalled).toBe(false);
	});

	it("rejects immediately when the signal is already aborted on entry (unchanged baseline)", async () => {
		const controller = new AbortController();
		controller.abort();
		const def = createGrepToolDefinition(process.cwd());
		const ctx = {} as Parameters<typeof def.execute>[4];
		await expect(
			def.execute("grep-pre-abort", { pattern: "x", path: "." }, controller.signal, undefined, ctx),
		).rejects.toThrow(/abort/i);
	});
});
