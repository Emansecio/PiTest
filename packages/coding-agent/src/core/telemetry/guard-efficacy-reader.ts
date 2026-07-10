/**
 * Cross-session reader for guard→next-call efficacy records persisted on the
 * diagnostics JSONL lane (`<agentDir>/diagnostics/<sessionId>.jsonl`).
 *
 * Wave E15 — minimal consumer: aggregate recent `{type:"efficacy"}` lines and
 * expose a thermostat prior that skips tighten for guards whose blocks/overrides
 * almost always precede a successful retry (nuisance / high false-positive proxy).
 * Wired from `SessionRecoveryController` → `SupervisionThermostat` at boot.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GuardEfficacyRecord } from "./guard-efficacy.ts";

/** Per-guard tallies aggregated across session files. */
export interface GuardEfficacyStats {
	guard: string;
	total: number;
	nextCallOk: number;
	/** `outcome:"overridden"` pairs where the next call succeeded — clear FP proxy. */
	overriddenOk: number;
}

export interface GuardEfficacyReaderOptions {
	/** Cap on session files scanned (newest by mtime). Default: 50. */
	maxSessionFiles?: number;
}

export interface ThermostatEfficacyPriorOptions {
	/** Minimum resolved pairs before a guard may suppress tighten. Default: 5. */
	minSamples?: number;
	/**
	 * Skip tighten when `nextCallOk / total` is at or above this rate. Default: 0.75.
	 * High rate means the guard usually precedes a successful retry — weak evidence
	 * that supervision should tighten (mirrors intent-gate-no-plan exemption).
	 */
	nuisanceRateThreshold?: number;
}

const DEFAULT_MAX_SESSION_FILES = 50;
const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_NUISANCE_RATE_THRESHOLD = 0.75;

function isEfficacyRecord(parsed: unknown): parsed is GuardEfficacyRecord {
	if (!parsed || typeof parsed !== "object") return false;
	const record = parsed as Record<string, unknown>;
	return (
		record.type === "efficacy" &&
		typeof record.guard === "string" &&
		(record.outcome === "blocked" || record.outcome === "overridden") &&
		typeof record.nextCallOk === "boolean"
	);
}

/** Ingest one JSONL line; returns an efficacy record or undefined. */
export function parseEfficacyLine(line: string): GuardEfficacyRecord | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return isEfficacyRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function listSessionFiles(dir: string, maxFiles: number): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => {
			try {
				return { name, mtimeMs: statSync(join(dir, name)).mtimeMs };
			} catch {
				return { name, mtimeMs: 0 };
			}
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs)
		.slice(0, maxFiles)
		.map((e) => e.name);
}

function ingestRecord(bucket: GuardEfficacyStats, record: GuardEfficacyRecord): void {
	bucket.total++;
	if (record.nextCallOk) bucket.nextCallOk++;
	if (record.outcome === "overridden" && record.nextCallOk) bucket.overriddenOk++;
}

/**
 * Load and aggregate efficacy records from the diagnostics directory. Skips
 * corrupt lines and non-efficacy records; fails open on unreadable files.
 */
export function loadGuardEfficacyStats(dir: string, options: GuardEfficacyReaderOptions = {}): GuardEfficacyStats[] {
	const maxFiles = options.maxSessionFiles ?? DEFAULT_MAX_SESSION_FILES;
	const byGuard = new Map<string, GuardEfficacyStats>();
	for (const file of listSessionFiles(dir, maxFiles)) {
		let raw: string;
		try {
			raw = readFileSync(join(dir, file), "utf-8");
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			const record = parseEfficacyLine(line);
			if (!record) continue;
			const bucket = byGuard.get(record.guard) ?? {
				guard: record.guard,
				total: 0,
				nextCallOk: 0,
				overriddenOk: 0,
			};
			ingestRecord(bucket, record);
			byGuard.set(record.guard, bucket);
		}
	}
	return [...byGuard.values()];
}

/**
 * Guards whose historical efficacy marks them as nuisance tighten signals.
 * Returned set is passed to `SupervisionThermostat` as `efficacySkipTightenGuards`.
 */
export function buildThermostatEfficacyPrior(
	stats: GuardEfficacyStats[],
	options: ThermostatEfficacyPriorOptions = {},
): ReadonlySet<string> {
	const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
	const threshold = options.nuisanceRateThreshold ?? DEFAULT_NUISANCE_RATE_THRESHOLD;
	const skip = new Set<string>();
	for (const s of stats) {
		if (s.total < minSamples) continue;
		if (s.nextCallOk / s.total >= threshold) skip.add(s.guard);
	}
	return skip;
}

/** Convenience: load stats from `dir` and build the thermostat prior in one call. */
export function loadThermostatEfficacyPrior(
	dir: string,
	options: GuardEfficacyReaderOptions & ThermostatEfficacyPriorOptions = {},
): ReadonlySet<string> {
	try {
		return buildThermostatEfficacyPrior(loadGuardEfficacyStats(dir, options), options);
	} catch {
		return new Set();
	}
}
