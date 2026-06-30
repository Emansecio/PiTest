import { describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.js";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.js";
import { BASH_MAX_BYTES } from "../src/core/tools/truncate.js";

const NODE = process.execPath;

/** Build args that run a tiny inline node program (cross-platform, no shell). */
function nodeEval(source: string): string[] {
	return ["-e", source];
}

describe("execCommand output bounding", () => {
	it("returns small normal output byte-identically with no truncation", async () => {
		const result = await execCommand(
			NODE,
			nodeEval("process.stdout.write('hello world'); process.stderr.write('warn'); process.exit(3);"),
			process.cwd(),
		);

		expect(result.stdout).toBe("hello world");
		expect(result.stderr).toBe("warn");
		expect(result.code).toBe(3);
		expect(result.killed).toBe(false);
		expect(result.truncated).toBeFalsy();
	});

	it("caps a verbose command instead of accumulating unbounded (OOM guard)", async () => {
		// Emit far more than BASH_MAX_BYTES so the rolling accumulator must elide the
		// middle. A real command (node) streams the bytes; nothing is mocked.
		const lineCount = 20_000;
		const result = await execCommand(
			NODE,
			nodeEval(
				`for (let i = 0; i < ${lineCount}; i++) process.stdout.write('LINE-' + i + ' padding-padding-padding\\n');`,
			),
			process.cwd(),
		);

		expect(result.code).toBe(0);
		expect(result.truncated).toBe(true);
		// Bounded well under the raw emission (~> 600KB) — never grows unbounded.
		const stdoutBytes = Buffer.byteLength(result.stdout, "utf-8");
		expect(stdoutBytes).toBeLessThan(BASH_MAX_BYTES * 4);
		// Head + tail are both preserved (first and last lines survive the elision).
		expect(result.stdout).toContain("LINE-0 ");
		expect(result.stdout).toContain(`LINE-${lineCount - 1} `);
		expect(result.stdout).toMatch(/elided/);
	}, 20_000);

	it("closes temp file streams after truncated output (no FD leak)", async () => {
		const closeSpy = vi.spyOn(OutputAccumulator.prototype, "closeTempFile");
		try {
			const lineCount = 20_000;
			await execCommand(
				NODE,
				nodeEval(
					`for (let i = 0; i < ${lineCount}; i++) process.stdout.write('LINE-' + i + ' padding-padding-padding\\n');`,
				),
				process.cwd(),
			);
			expect(closeSpy).toHaveBeenCalledTimes(2);
		} finally {
			closeSpy.mockRestore();
		}
	}, 20_000);

	it("clears the SIGKILL escalation timer on normal settle (no orphan timer)", async () => {
		const clearSpy = vi.spyOn(globalThis, "clearTimeout");
		try {
			const result = await execCommand(
				NODE,
				// Use a short timeout so the kill-escalation path's setTimeout is armed
				// only if it fires; on a fast normal exit it must never leak.
				nodeEval("process.stdout.write('done'); process.exit(0);"),
				process.cwd(),
				{ timeout: 10_000 },
			);

			expect(result.stdout).toBe("done");
			expect(result.code).toBe(0);
			expect(result.killed).toBe(false);
			// The timeout timer was armed and must be cleared on settle.
			expect(clearSpy).toHaveBeenCalled();
		} finally {
			clearSpy.mockRestore();
		}
	});

	it("marks killed and clears timers when aborted mid-flight", async () => {
		const controller = new AbortController();
		const clearSpy = vi.spyOn(globalThis, "clearTimeout");
		try {
			const promise = execCommand(NODE, nodeEval("setTimeout(() => process.exit(0), 60_000);"), process.cwd(), {
				signal: controller.signal,
			});
			// Abort almost immediately; the process is still alive.
			setTimeout(() => controller.abort(), 50);
			const result = await promise;

			expect(result.killed).toBe(true);
			// Settle path always clears the escalation/timeout timers.
			expect(clearSpy).toHaveBeenCalled();
		} finally {
			clearSpy.mockRestore();
		}
	}, 15_000);
});
