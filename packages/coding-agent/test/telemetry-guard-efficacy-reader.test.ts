import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDiagnostic, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SupervisionThermostat } from "../src/core/supervision-thermostat.ts";
import {
	buildThermostatEfficacyPrior,
	loadGuardEfficacyStats,
	loadThermostatEfficacyPrior,
	parseEfficacyLine,
} from "../src/core/telemetry/guard-efficacy-reader.js";

let dir: string;

function writeSessionFile(name: string, lines: object[], mtimeOffsetSec = 0): void {
	const path = join(dir, name);
	writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	if (mtimeOffsetSec !== 0) {
		const t = Date.now() / 1000 - mtimeOffsetSec;
		utimesSync(path, t, t);
	}
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-efficacy-reader-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("parseEfficacyLine", () => {
	it("parses a valid efficacy record and ignores other line types", () => {
		expect(
			parseEfficacyLine(
				JSON.stringify({
					type: "efficacy",
					guard: "guard.grounding",
					outcome: "blocked",
					nextCallOk: true,
					ts: 1,
				}),
			),
		).toMatchObject({ guard: "guard.grounding", nextCallOk: true });
		expect(parseEfficacyLine(JSON.stringify({ type: "event", category: "guard.read" }))).toBeUndefined();
		expect(parseEfficacyLine("not-json")).toBeUndefined();
	});
});

describe("loadGuardEfficacyStats", () => {
	it("aggregates efficacy lines across session files", () => {
		writeSessionFile("a.jsonl", [
			{ type: "manifest", sessionId: "a" },
			{ type: "efficacy", guard: "guard.grounding", outcome: "blocked", nextCallOk: true, ts: 1 },
			{ type: "efficacy", guard: "guard.grounding", outcome: "blocked", nextCallOk: false, ts: 2 },
		]);
		writeSessionFile("b.jsonl", [
			{ type: "efficacy", guard: "guard.grounding", outcome: "overridden", nextCallOk: true, ts: 3 },
			{ type: "efficacy", guard: "guard.read", outcome: "blocked", nextCallOk: true, ts: 4 },
		]);

		const stats = loadGuardEfficacyStats(dir);
		const grounding = stats.find((s) => s.guard === "guard.grounding");
		expect(grounding).toEqual({ guard: "guard.grounding", total: 3, nextCallOk: 2, overriddenOk: 1 });
		expect(stats.find((s) => s.guard === "guard.read")).toEqual({
			guard: "guard.read",
			total: 1,
			nextCallOk: 1,
			overriddenOk: 0,
		});
	});

	it("returns empty for a missing directory", () => {
		expect(loadGuardEfficacyStats(join(dir, "missing"))).toEqual([]);
	});

	it("respects maxSessionFiles (newest by mtime)", () => {
		writeSessionFile("old.jsonl", [
			{ type: "efficacy", guard: "guard.old", outcome: "blocked", nextCallOk: true, ts: 1 },
		]);
		writeSessionFile("new.jsonl", [
			{ type: "efficacy", guard: "guard.new", outcome: "blocked", nextCallOk: true, ts: 2 },
		]);
		utimesSync(join(dir, "old.jsonl"), Date.now() / 1000 - 3600, Date.now() / 1000 - 3600);

		const stats = loadGuardEfficacyStats(dir, { maxSessionFiles: 1 });
		expect(stats.map((s) => s.guard)).toEqual(["guard.new"]);
	});
});

describe("buildThermostatEfficacyPrior", () => {
	it("marks guards with enough high nextCallOk rate for tighten skip", () => {
		const prior = buildThermostatEfficacyPrior(
			[
				{ guard: "guard.grounding", total: 5, nextCallOk: 4, overriddenOk: 0 },
				{ guard: "guard.read", total: 5, nextCallOk: 2, overriddenOk: 0 },
				{ guard: "guard.sparse", total: 2, nextCallOk: 2, overriddenOk: 0 },
			],
			{ minSamples: 5, nuisanceRateThreshold: 0.75 },
		);
		expect(prior.has("guard.grounding")).toBe(true);
		expect(prior.has("guard.read")).toBe(false);
		expect(prior.has("guard.sparse")).toBe(false);
	});

	it("loadThermostatEfficacyPrior fails open on errors", () => {
		expect(loadThermostatEfficacyPrior(join(dir, "nope"))).toEqual(new Set());
	});
});

describe("SupervisionThermostat efficacy prior (E15 wire)", () => {
	beforeEach(() => {
		delete process.env.PIT_NO_SUPERVISION_THERMOSTAT;
		resetRuntimeDiagnostics();
	});

	afterEach(() => {
		delete process.env.PIT_NO_SUPERVISION_THERMOSTAT;
	});

	it("skips tighten for guards in efficacySkipTightenGuards", () => {
		const t = new SupervisionThermostat({
			efficacySkipTightenGuards: new Set(["guard.grounding"]),
		});
		try {
			recordDiagnostic({
				category: "guard.grounding",
				level: "warn",
				source: "test",
				context: { outcome: "blocked" },
			});
			expect(t.getLevel()).toBe("padrao");
		} finally {
			t.dispose();
		}
	});

	it("still tightens guards not in the efficacy prior", () => {
		const t = new SupervisionThermostat({
			efficacySkipTightenGuards: new Set(["guard.grounding"]),
		});
		try {
			recordDiagnostic({
				category: "guard.read",
				level: "warn",
				source: "test",
				context: { outcome: "blocked" },
			});
			expect(t.getLevel()).toBe("assistido");
		} finally {
			t.dispose();
		}
	});
});
