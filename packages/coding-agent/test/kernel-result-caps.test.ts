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
import { formatKernelResult } from "../src/core/tools/eval.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { ERROR_TEXT_CAP_BYTES } from "../src/core/tools/truncate.ts";

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

	it("tail-keeps an oversized NON-repeating stdout and spills the full output to a temp file", async () => {
		// Distinct (non-collapsible) lines: alpha-encode the counter so there are no
		// digit/hex tokens to fuzzy-merge — this exercises the byte cut, not N2 collapse.
		const alpha = (n: number) => n.toString().replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]);
		const lines: string[] = ["HEAD_SENTINEL_first_line"];
		for (let i = 0; i < 4000; i++) lines.push(`entry-${alpha(i)}-payloadpayloadpayload`);
		lines.push("TAIL_SENTINEL_last_line");
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
		expect(text).toContain("TAIL_SENTINEL_last_line");
		expect(text).not.toContain("HEAD_SENTINEL_first_line");
		// Distinct lines → no fuzzy collapse.
		expect(text).not.toContain("similar)");
		// error kept in full regardless.
		expect(text).toContain("Error: failed at the end");
		// Spill note points at a recoverable file.
		expect(text).toContain("full output at");
		const spill = extractSpillPath(text);
		expect(spill).toBeTruthy();
		spilledPaths.push(spill as string);

		const full = await readFile(spill as string, "utf-8");
		// The spill has the COMPLETE stdout (head included) plus the error section.
		expect(full).toContain("HEAD_SENTINEL_first_line");
		expect(full).toContain("TAIL_SENTINEL_last_line");
		expect(full).toContain("Error: failed at the end");
	});

	it("collapses a runaway loop's similar stdout before the byte cut, error intact (N2.3)", async () => {
		// 5000 lines that differ only in counters/timestamps — masked-equal, so they
		// collapse to the first line + a "(×N similar)" marker instead of a tail cut.
		const lines: string[] = [];
		for (let i = 0; i < 5000; i++) lines.push(`processed record ${i} in ${i * 3}ms`);
		const stdout = lines.join("\n");
		expect(Buffer.byteLength(stdout, "utf-8")).toBeGreaterThan(64 * 1024);

		const text = await formatKernelResult({
			label: "lang=python",
			stdout,
			stderr: "",
			error: "ValueError: exact error text 12345 must survive",
			durationMs: 7,
		});

		// The whole wall collapsed to the first representative line + a similar-count marker.
		expect(text).toContain("processed record 0 in 0ms … (×5000 similar)");
		// Collapsed small → NOT truncated, NOT spilled.
		expect(text).not.toContain("full output at");
		expect(text).not.toContain("truncated to the last");
		// The error section is never collapsed and never truncated — exact text survives.
		expect(text).toContain("ValueError: exact error text 12345 must survive");
		// Massive shrink.
		expect(text.length).toBeLessThan(stdout.length / 50);
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

	it("caps a 1MB thrown-error message at ~16KB, keeping head AND tail", async () => {
		// Realistic giant-error shape: an opening message line, a wall of stack
		// frames, and the decisive final line — 1MB total.
		const head = "HEAD-SENTINEL: tool exploded";
		const tail = "TAIL-SENTINEL: caused by ECONNRESET";
		const frames = Array(24_000).fill("    at somewhere (/very/deep/module.ts:1:1)").join("\n");
		const message = `${head}\n${frames}\n${tail}`;
		expect(Buffer.byteLength(message, "utf-8")).toBeGreaterThan(1024 * 1024);
		const tool = throwingTool(message);
		let caught: unknown;
		try {
			await tool.execute("t1", {}, new AbortController().signal);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		const e = caught as Error;
		// Down from 1MB to the dedicated 16KB error budget (+ marker slack).
		expect(Buffer.byteLength(e.message, "utf-8")).toBeLessThan(ERROR_TEXT_CAP_BYTES + 512);
		// Head+tail cut: both ends survive, the middle frames are elided.
		expect(e.message).toContain(head);
		expect(e.message).toContain(tail);
		expect(e.message).toContain("truncated from the middle");
		expect(e.message).toContain("[error text exceeded");
		expect(e.message).toContain("kept head + tail]");
		// Stack preserved for local debugging.
		expect(typeof e.stack).toBe("string");
	});

	it("keeps the tail of a single-line 1MB message (head snaps to whole lines)", async () => {
		// A one-line payload (echoed minified JSON, etc.): truncateHead never
		// returns partial lines, so the head half is empty — the size cap and the
		// tail (where the decisive signal of an echoed payload ends) still hold.
		const tool = throwingTool(`${"Q".repeat(1024 * 1024)}TAIL-SENTINEL`);
		let caught: unknown;
		try {
			await tool.execute("t1b", {}, new AbortController().signal);
		} catch (err) {
			caught = err;
		}
		const e = caught as Error;
		expect(Buffer.byteLength(e.message, "utf-8")).toBeLessThan(ERROR_TEXT_CAP_BYTES + 512);
		expect(e.message).toContain("TAIL-SENTINEL");
		expect(e.message).toContain("kept head + tail]");
	});

	it("preserves the error subclass and extra properties when capping", async () => {
		class ToolFailure extends Error {
			code = "E_BOOM";
		}
		const tool = wrapToolDefinition({
			name: "boom-typed",
			label: "boom-typed",
			description: "throws a subclass",
			parameters: Type.Object({}),
			async execute() {
				throw Object.assign(new ToolFailure("X".repeat(64 * 1024)), { code: "E_BOOM" });
			},
		});
		let caught: unknown;
		try {
			await tool.execute("t3", {}, new AbortController().signal);
		} catch (err) {
			caught = err;
		}
		// The SAME object is rethrown with its message capped in place.
		expect(caught).toBeInstanceOf(ToolFailure);
		expect((caught as ToolFailure).code).toBe("E_BOOM");
		expect(Buffer.byteLength((caught as Error).message, "utf-8")).toBeLessThan(ERROR_TEXT_CAP_BYTES + 512);
	});

	it("stringifies and caps a non-Error throw", async () => {
		const tool = wrapToolDefinition({
			name: "boom-string",
			label: "boom-string",
			description: "throws a raw string",
			parameters: Type.Object({}),
			async execute() {
				throw "S".repeat(128 * 1024);
			},
		});
		let caught: unknown;
		try {
			await tool.execute("t4", {}, new AbortController().signal);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(Buffer.byteLength((caught as Error).message, "utf-8")).toBeLessThan(ERROR_TEXT_CAP_BYTES + 512);
		expect((caught as Error).message).toContain("[error text exceeded");
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
