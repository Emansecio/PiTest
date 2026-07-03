import type { DiagnosticSnapshot } from "@pit/ai";
import { describe, expect, it } from "vitest";
import type { CacheStats } from "../src/core/cache-stats.js";
import type { RecoverySnapshot } from "../src/core/session-recovery.js";
import { buildSessionSummaryRecord } from "../src/core/telemetry/session-summary.js";

const recovery: RecoverySnapshot = { level: "guided", rollingScore: 2, totalThrashScore: 5, cleanStreak: 1 };

const diagnostics: DiagnosticSnapshot = {
	counters: {
		"guard.read": { count: 3, level: "info", lastSeq: 9 },
		"guard.grounding": { count: 1, level: "warn", lastSeq: 4 },
	},
	recent: [],
	total: 4,
};

describe("buildSessionSummaryRecord", () => {
	it("flattens diagnostics counters to counts and carries the recovery snapshot", () => {
		const record = buildSessionSummaryRecord({ recovery, diagnostics });
		expect(record.type).toBe("session-summary");
		expect(record.ts).toBeTypeOf("number");
		expect(record.recovery).toEqual(recovery);
		expect(record.diagnostics).toEqual({ total: 4, counters: { "guard.read": 3, "guard.grounding": 1 } });
		expect(record.verification).toBeUndefined();
		expect(record.cache).toBeUndefined();
	});

	it("includes the verification tally when provided", () => {
		const record = buildSessionSummaryRecord({ recovery, diagnostics, verification: { attempts: 4, failures: 2 } });
		expect(record.verification).toEqual({ attempts: 4, failures: 2 });
	});

	it("reduces cache stats to totals when provided", () => {
		const cache: CacheStats = {
			turns: [{ index: 1, input: 10, cacheRead: 90, cacheWrite: 0, promptTokens: 100, hitRate: 0.9 }],
			totalInput: 10,
			totalCacheRead: 90,
			totalCacheWrite: 0,
			promptTokens: 100,
			hitRate: 0.9,
			estReadSavingsTokens: 81,
			instabilityTurn: null,
			cacheObserved: true,
		};
		const record = buildSessionSummaryRecord({ recovery, diagnostics, cache });
		expect(record.cache).toEqual({
			promptTokens: 100,
			totalInput: 10,
			totalCacheRead: 90,
			totalCacheWrite: 0,
			hitRate: 0.9,
			instabilityTurn: null,
			cacheObserved: true,
		});
		// The per-turn array must not leak into the compact summary.
		expect(record.cache).not.toHaveProperty("turns");
	});
});
