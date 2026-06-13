import { getRuntimeDiagnostics, recordDiagnostic, resetRuntimeDiagnostics } from "@pit/ai";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { formatRuntimeDiagnostics } from "./diagnostics-summary.ts";
import { initTheme } from "./theme/theme.ts";

// Strip ANSI so assertions target the literal text regardless of theme coloring.
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("formatRuntimeDiagnostics", () => {
	beforeAll(() => {
		// theme.fg/bold go through a lazy proxy that throws until initialized.
		initTheme();
	});

	beforeEach(() => {
		resetRuntimeDiagnostics();
	});

	it("returns the empty-state line when nothing recorded", () => {
		const out = stripAnsi(formatRuntimeDiagnostics(getRuntimeDiagnostics()));
		expect(out).toBe("No runtime diagnostics recorded this session.");
	});

	it("summarizes counters ordered by count desc with level, count and last context", () => {
		// output.cap fires 3×, process.kill once → output.cap must sort first.
		recordDiagnostic({
			category: "output.cap",
			level: "warn",
			source: "eval-kernel.python",
			context: { bytes: 1024 },
		});
		recordDiagnostic({
			category: "output.cap",
			level: "warn",
			source: "eval-kernel.python",
			context: { bytes: 4096 },
		});
		recordDiagnostic({
			category: "output.cap",
			level: "warn",
			source: "eval-kernel.python",
			context: { bytes: 8388608 },
		});
		recordDiagnostic({ category: "process.kill", level: "error", source: "shell.spawn", context: { pid: 4242 } });

		const snapshot = getRuntimeDiagnostics();
		expect(snapshot.total).toBe(4);

		const out = stripAnsi(formatRuntimeDiagnostics(snapshot));
		expect(out).toContain("Total events: 4");
		// output.cap line: ×3, warn, last context bytes=8388608 (most recent event).
		expect(out).toContain("output.cap  ×3  warn  (eval-kernel.python bytes=8388608)");
		// process.kill line: ×1, error, pid from context.
		expect(out).toContain("process.kill  ×1  error  (shell.spawn pid=4242)");
		// Ordering: the higher-count category appears before the lower-count one.
		expect(out.indexOf("output.cap")).toBeLessThan(out.indexOf("process.kill"));
	});
});
