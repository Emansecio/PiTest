import { beforeEach, describe, expect, it } from "vitest";
import {
	getRuntimeDiagnostics,
	onDiagnostic,
	recordDiagnostic,
	resetRuntimeDiagnostics,
} from "../src/utils/runtime-diagnostics.ts";

describe("runtime-diagnostics", () => {
	beforeEach(() => {
		resetRuntimeDiagnostics();
	});

	it("counts per category and keeps the last context", () => {
		recordDiagnostic({ category: "output.cap", level: "warn", source: "a", context: { bytes: 10 } });
		recordDiagnostic({ category: "output.cap", level: "warn", source: "a", context: { bytes: 20 } });
		recordDiagnostic({ category: "process.kill", level: "error", source: "b", context: { pid: 42 } });

		const snap = getRuntimeDiagnostics();
		expect(snap.total).toBe(3);
		expect(snap.counters["output.cap"]?.count).toBe(2);
		expect(snap.counters["output.cap"]?.lastContext?.bytes).toBe(20);
		expect(snap.counters["process.kill"]?.count).toBe(1);
		expect(snap.counters["process.kill"]?.level).toBe("error");
	});

	it("retains recent events in arrival order, bounded to the ring size", () => {
		for (let i = 0; i < 250; i++) {
			recordDiagnostic({ category: "io.retry", level: "info", source: "s", context: { attempt: i } });
		}
		const snap = getRuntimeDiagnostics();
		// Ring is capped at 200; counter still reflects every occurrence.
		expect(snap.recent.length).toBe(200);
		expect(snap.counters["io.retry"]?.count).toBe(250);
		// Oldest dropped: the first retained attempt is 50, the last is 249.
		expect(snap.recent[0]?.context?.attempt).toBe(50);
		expect(snap.recent[snap.recent.length - 1]?.context?.attempt).toBe(249);
		// seq is monotonic across the whole run, not reset by the ring trim.
		expect(snap.recent[snap.recent.length - 1]?.seq).toBe(250);
	});

	it("notifies subscribers and stops after unsubscribe", () => {
		const seen: string[] = [];
		const unsub = onDiagnostic((e) => seen.push(e.category));
		recordDiagnostic({ category: "stream.idle-timeout", level: "warn", source: "x" });
		unsub();
		recordDiagnostic({ category: "net.connect-timeout", level: "warn", source: "y" });
		expect(seen).toEqual(["stream.idle-timeout"]);
	});

	it("a throwing subscriber never breaks recording", () => {
		onDiagnostic(() => {
			throw new Error("bridge boom");
		});
		expect(() => recordDiagnostic({ category: "error.isolated", level: "error", source: "z" })).not.toThrow();
		expect(getRuntimeDiagnostics().counters["error.isolated"]?.count).toBe(1);
	});

	it("reset clears counters, ring and seq", () => {
		recordDiagnostic({ category: "input.truncated", level: "info", source: "p" });
		resetRuntimeDiagnostics();
		const snap = getRuntimeDiagnostics();
		expect(snap.total).toBe(0);
		expect(snap.recent.length).toBe(0);
		expect(Object.keys(snap.counters).length).toBe(0);
	});
});
