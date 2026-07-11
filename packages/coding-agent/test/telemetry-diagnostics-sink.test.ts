import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDiagnostic, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiagnosticsSink } from "../src/core/telemetry/diagnostics-sink.js";

let dir: string;
const sinks: DiagnosticsSink[] = [];

function makeSink(sessionId: string, cwd = "/x"): DiagnosticsSink {
	const sink = new DiagnosticsSink(dir, { sessionId, cwd });
	sinks.push(sink);
	return sink;
}

function readLines(sessionId: string): Array<Record<string, unknown>> {
	const raw = readFileSync(join(dir, `${sessionId}.jsonl`), "utf-8");
	return raw
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

beforeEach(() => {
	delete process.env.PIT_NO_TELEMETRY_SINK;
	resetRuntimeDiagnostics();
	dir = mkdtempSync(join(tmpdir(), "pi-diag-sink-"));
});

afterEach(() => {
	for (const sink of sinks.splice(0)) sink.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("DiagnosticsSink", () => {
	it("writes a manifest first line then event lines from onDiagnostic", () => {
		const sink = makeSink("s1");
		sink.start();
		recordDiagnostic({ category: "guard.grounding", level: "warn", source: "test", context: { note: "edit" } });
		recordDiagnostic({ category: "guard.read", level: "info", source: "test" });
		sink.flush();

		const lines = readLines("s1");
		expect(lines[0]).toMatchObject({ type: "manifest", sessionId: "s1", cwd: "/x" });
		expect(lines[0].timestamp).toBeTypeOf("string");
		expect(lines[1]).toMatchObject({ type: "event", category: "guard.grounding", level: "warn" });
		// Foundation stamps ts + seq on every recorded event.
		expect(lines[1].seq).toBeTypeOf("number");
		expect(lines[1].ts).toBeTypeOf("number");
		expect(lines[2]).toMatchObject({ type: "event", category: "guard.read" });
	});

	it("appends across flushes, writing the manifest exactly once", () => {
		const sink = makeSink("s2");
		sink.start();
		recordDiagnostic({ category: "guard.read", level: "info", source: "t" });
		sink.flush();
		recordDiagnostic({ category: "guard.import-grounding", level: "warn", source: "t" });
		sink.flush();

		const lines = readLines("s2");
		expect(lines.filter((l) => l.type === "manifest").length).toBe(1);
		expect(lines.filter((l) => l.type === "event").length).toBe(2);
	});

	it("routes writeRecord onto the same lane", () => {
		const sink = makeSink("s3");
		sink.start();
		sink.writeRecord({ type: "efficacy", guard: "guard.read", outcome: "blocked", nextCallOk: true, ts: 1 });
		sink.flush();
		const lines = readLines("s3");
		expect(lines.find((l) => l.type === "efficacy")).toMatchObject({ guard: "guard.read", nextCallOk: true });
	});

	it("is a no-op when PIT_NO_TELEMETRY_SINK=1", () => {
		process.env.PIT_NO_TELEMETRY_SINK = "1";
		const sink = makeSink("s4");
		sink.start();
		recordDiagnostic({ category: "guard.read", level: "info", source: "t" });
		sink.flush();
		expect(readdirSync(dir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(0);
	});

	it("flush is a no-op with an empty buffer (no file created)", () => {
		const sink = makeSink("s5");
		sink.start();
		sink.flush();
		expect(readdirSync(dir)).toHaveLength(0);
	});

	it("stops recording after dispose", () => {
		const sink = makeSink("s6");
		sink.start();
		recordDiagnostic({ category: "guard.read", level: "info", source: "t" });
		sink.dispose();
		const before = readLines("s6").length;
		recordDiagnostic({ category: "guard.read", level: "info", source: "t" });
		sink.flush();
		expect(readLines("s6").length).toBe(before);
	});

	it("prunes to at most MAX_SESSION_FILES when a new file is created", () => {
		// Seed 200 stale files with old mtimes, then create the 201st via the sink.
		for (let i = 0; i < 200; i++) {
			const p = join(dir, `old-${i}.jsonl`);
			writeFileSync(p, "{}\n");
			const past = Date.now() / 1000 - (200 - i) * 60;
			utimesSync(p, past, past);
		}
		const sink = makeSink("fresh");
		sink.start();
		recordDiagnostic({ category: "guard.read", level: "info", source: "t" });
		sink.flush();

		const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		expect(files.length).toBeLessThanOrEqual(200);
		// The freshly written session file survives; the oldest seed was pruned.
		expect(files).toContain("fresh.jsonl");
		expect(statSync(join(dir, "fresh.jsonl")).isFile()).toBe(true);
	});

	it("defers JSON.stringify until flush and drops unserialisable records", () => {
		const sink = makeSink("s7");
		sink.start();
		const circular: Record<string, unknown> = { type: "bad" };
		circular.self = circular;
		sink.writeRecord(circular);
		sink.writeRecord({ type: "efficacy", guard: "guard.read", outcome: "ok", ts: 1 });
		sink.flush();

		const lines = readLines("s7");
		expect(lines.find((l) => l.type === "efficacy")).toMatchObject({ guard: "guard.read" });
		expect(lines.some((l) => l.type === "bad")).toBe(false);
	});
});
