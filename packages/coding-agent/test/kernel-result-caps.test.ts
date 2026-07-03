/**
 * Caps behavior landed for REVISAO-TOOLS-PIT §5.8 / §6.2:
 *
 * 1. `formatKernelResult` (shared by `eval` + `code`) truncates stdout/stderr
 *    per-section from the TAIL, NEVER touches the `error` section, and spills
 *    the full untouched text to a temp file recoverable via `read`.
 * 2. `wrapToolDefinition` caps a THROWN error's message text (the resolved-result
 *    cap never saw it) so an oversized stack/echoed-input error can no longer
 *    reach the model uncapped.
 *
 * Pure/deterministic — no kernel process, no network.
 */

import { readFile, unlink } from "node:fs/promises";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { EVAL_OUTPUT_CAP_BYTES, formatKernelResult } from "../src/core/tools/eval.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

const spilledPaths: string[] = [];

afterEach(async () => {
	for (const p of spilledPaths.splice(0)) {
		try {
			await unlink(p);
		} catch {
			// best-effort cleanup
		}
	}
});

function extractSpillPath(text: string): string | undefined {
	const m = text.match(/full output at (.+?) — read it/);
	return m?.[1];
}

describe("formatKernelResult section-aware caps", () => {
	it("never truncates the error section, even when it is far larger than a section budget", async () => {
		const hugeError = `Traceback:\n${"E".repeat(100 * 1024)}\nValueError: boom`;
		const text = await formatKernelResult({
			label: "lang=python",
			stdout: "",
			stderr: "",
			error: hugeError,
			durationMs: 5,
		});
		// The entire error body survives verbatim.
		expect(text).toContain(hugeError);
		// error alone is not truncatable → no spill note.
		expect(text).not.toContain("truncated to the last");
	});

	it("tail-keeps an oversized stdout and spills the full output to a temp file", async () => {
		const lines: string[] = [];
		for (let i = 0; i < 4000; i++) lines.push(`line-${String(i).padStart(6, "0")}-payloadpayloadpayload`);
		const stdout = lines.join("\n");
		expect(Buffer.byteLength(stdout, "utf-8")).toBeGreaterThan(64 * 1024);

		const text = await formatKernelResult({
			label: "lang=javascript",
			stdout,
			stderr: "",
			error: "Error: failed at the end",
			durationMs: 12,
		});

		// TAIL kept: the last line is present, the first line is gone.
		expect(text).toContain("line-003999-");
		expect(text).not.toContain("line-000000-");
		// error kept in full regardless.
		expect(text).toContain("Error: failed at the end");
		// Spill note points at a recoverable file.
		expect(text).toContain("full output at");
		const spill = extractSpillPath(text);
		expect(spill).toBeTruthy();
		spilledPaths.push(spill as string);

		const full = await readFile(spill as string, "utf-8");
		// The spill has the COMPLETE stdout (head included) plus the error section.
		expect(full).toContain("line-000000-");
		expect(full).toContain("line-003999-");
		expect(full).toContain("Error: failed at the end");
	});

	it("leaves small output untouched and inline (no spill, no truncation note)", async () => {
		const text = await formatKernelResult({
			label: "lang=javascript",
			stdout: "42",
			stderr: "",
			error: undefined,
			durationMs: 1,
		});
		expect(text).toContain("stdout: 42");
		expect(text).not.toContain("full output at");
		expect(text).not.toContain("truncated");
	});
});

describe("wrapToolDefinition thrown-error cap", () => {
	function throwingTool(message: string) {
		return wrapToolDefinition({
			name: "boom",
			label: "boom",
			description: "throws",
			parameters: Type.Object({}),
			async execute() {
				throw new Error(message);
			},
		});
	}

	it("caps an oversized thrown-error message and marks it truncated", async () => {
		const tool = throwingTool("Q".repeat(200 * 1024));
		let caught: unknown;
		try {
			await tool.execute("t1", {}, new AbortController().signal);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		const e = caught as Error;
		// Well under the raw 200KB, over the 64KB cap by only the marker text.
		expect(Buffer.byteLength(e.message, "utf-8")).toBeLessThan(EVAL_OUTPUT_CAP_BYTES + 512);
		expect(e.message).toContain("[error text exceeded");
		expect(e.message).toContain("truncated]");
		// Stack preserved for local debugging.
		expect(typeof e.stack).toBe("string");
	});

	it("passes a small thrown error through unchanged", async () => {
		const tool = throwingTool("plain small failure");
		let caught: unknown;
		try {
			await tool.execute("t2", {}, new AbortController().signal);
		} catch (err) {
			caught = err;
		}
		const e = caught as Error;
		expect(e.message).toBe("plain small failure");
		expect(e.message).not.toContain("[error text exceeded");
	});
});
