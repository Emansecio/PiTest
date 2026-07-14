/**
 * Plan 009 Fix B: count-dominant promotion of learned errors. A pattern that
 * burns the model many times in a SINGLE session (totalCount >= threshold) now
 * qualifies for both a reactive Tier-4 hint rule and the preventive guard,
 * bypassing the >=2-sessions bar — while the cross-session bar still qualifies
 * lower-count patterns (regression). Both the hint registry and the guard use
 * the SAME `qualifiesForLearnedRule` gate, so they can never drift.
 *
 * All fixtures are SYNTHETIC — never the user's real learned-error store.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createLearnedErrorGuardExtension } from "../src/core/built-ins/learned-error-guard-extension.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { AggregatedLearnedError } from "../src/core/learned-error-store.ts";
import { fingerprintToolArgs } from "../src/core/tool-call-stats.ts";
import { createLearnedErrorRules, qualifiesForLearnedRule } from "../src/core/tool-error-hint-rules.ts";

const THRESHOLDS = { minOccurrences: 3, minSessions: 2, countDominantThreshold: 5 };

function entry(over: Partial<AggregatedLearnedError>): AggregatedLearnedError {
	return {
		tool: "task",
		fingerprint: "unknown agent type general-purpose",
		totalCount: 1,
		sessionCount: 1,
		matchedRuleIds: [],
		sampleErrorText: 'task: unknown agent type "general-purpose".',
		...over,
	};
}

describe("qualifiesForLearnedRule (shared gate)", () => {
	it("count-dominant: totalCount>=5 from a single session qualifies", () => {
		expect(qualifiesForLearnedRule(entry({ totalCount: 5, sessionCount: 1 }), THRESHOLDS)).toBe(true);
	});

	it("count=4 from a single session does NOT qualify", () => {
		expect(qualifiesForLearnedRule(entry({ totalCount: 4, sessionCount: 1 }), THRESHOLDS)).toBe(false);
	});

	it("cross-session bar still qualifies count=3 across 2 sessions (regression)", () => {
		expect(qualifiesForLearnedRule(entry({ totalCount: 3, sessionCount: 2 }), THRESHOLDS)).toBe(true);
	});

	it("an entry already covered by a built-in rule never qualifies", () => {
		expect(
			qualifiesForLearnedRule(entry({ totalCount: 99, sessionCount: 9, matchedRuleIds: ["some-rule"] }), THRESHOLDS),
		).toBe(false);
	});
});

describe("createLearnedErrorRules count-dominant promotion", () => {
	it("materialises a rule from a single high-count session", () => {
		const rules = createLearnedErrorRules([entry({ totalCount: 5, sessionCount: 1 })]);
		expect(rules).toHaveLength(1);
	});

	it("does not materialise a rule at count=4 / 1 session", () => {
		const rules = createLearnedErrorRules([entry({ totalCount: 4, sessionCount: 1 })]);
		expect(rules).toHaveLength(0);
	});

	it("still materialises the cross-session case (count=3 / 2 sessions)", () => {
		const rules = createLearnedErrorRules([entry({ totalCount: 3, sessionCount: 2 })]);
		expect(rules).toHaveLength(1);
	});

	it("respects maxRules", () => {
		const many = Array.from({ length: 10 }, (_, i) =>
			entry({ totalCount: 6, sessionCount: 1, fingerprint: `fp-${i}` }),
		);
		const rules = createLearnedErrorRules(many, { maxRules: 3 });
		expect(rules).toHaveLength(3);
	});
});

describe("learned-error guard mirrors the count-dominant gate", () => {
	const originalEnvFlag = process.env.PIT_NO_LEARNED_ERROR_GUARD;
	afterEach(() => {
		if (originalEnvFlag === undefined) delete process.env.PIT_NO_LEARNED_ERROR_GUARD;
		else process.env.PIT_NO_LEARNED_ERROR_GUARD = originalEnvFlag;
	});

	function makeFakePi() {
		const handlers = new Map<string, ((e: unknown) => unknown)[]>();
		const api = {
			on(event: string, handler: (e: unknown) => unknown) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
		} as unknown as ExtensionAPI;
		const fire = async (event: string, payload: unknown): Promise<unknown> => {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) {
				const r = await handler(payload);
				if (r !== undefined && result === undefined) result = r;
			}
			return result;
		};
		return { api, fire };
	}

	const input = { type: "general-purpose", prompt: "go" };
	const sampleArgs = fingerprintToolArgs(input, 160);

	async function fireGuard(count: number): Promise<{ block?: boolean } | undefined> {
		delete process.env.PIT_NO_LEARNED_ERROR_GUARD;
		const ext = createLearnedErrorGuardExtension({
			enabled: true,
			provider: () => [entry({ tool: "task", totalCount: count, sessionCount: 1, sampleArgs })],
		});
		const { api, fire } = makeFakePi();
		ext(api);
		return (await fire("tool_call", { toolName: "task", input, toolCallId: "t1" })) as
			| { block?: boolean }
			| undefined;
	}

	it("blocks a count-dominant single-session pattern (count=5)", async () => {
		const outcome = await fireGuard(5);
		expect(outcome?.block).toBe(true);
	});

	it("does not block below the threshold (count=4, single session)", async () => {
		const outcome = await fireGuard(4);
		expect(outcome).toBeUndefined();
	});
});
