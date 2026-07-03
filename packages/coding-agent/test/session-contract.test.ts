import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	EXPIRY_PASSES,
	type ExtractedConstraint,
	extractConstraints,
	formatSessionContractBlock,
	getCurrentSessionContract,
	MAX_CONSTRAINTS,
	parseBiomeRules,
	parseTypeScriptErrors,
	type SessionConstraint,
	SessionContract,
	setCurrentSessionContract,
} from "../src/core/session-contract.ts";

function ec(id: string, text = id): ExtractedConstraint {
	return { id, text, source: "biome" };
}

/** Build a tracked constraint for render-only tests. */
function tracked(id: string, hits: number, addedAt: number): SessionConstraint {
	return { id, text: id, source: "biome", hits, addedAt, passesSinceLastFire: 0 };
}

// A realistic biome check failure (header line + `×` message + code frame).
const BIOME_OUTPUT = `
src/foo.ts:3:8 lint/style/noEnum ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  × Use a union of string literals instead of an enum.

    1 │ export enum Color {
      │             ^^^^^

src/bar.ts:9:1 lint/suspicious/noExplicitAny  FIXABLE  ━━━━━━━━

  × Unexpected any. Specify a different type.
`;

describe("parseBiomeRules", () => {
	it("extracts the rule id and the human gist from header + message lines", () => {
		const rules = parseBiomeRules(BIOME_OUTPUT);
		const byRule = new Map(rules.map((r) => [r.rule, r.gist]));
		expect(byRule.get("lint/style/noEnum")).toBe("Use a union of string literals instead of an enum.");
		expect(byRule.get("lint/suspicious/noExplicitAny")).toBe("Unexpected any. Specify a different type.");
	});

	it("dedupes a rule that fires on multiple lines (first gist wins)", () => {
		const out = `a.ts:1:1 lint/style/noEnum\n  × first message.\nb.ts:2:2 lint/style/noEnum\n  × second message.`;
		const rules = parseBiomeRules(out);
		expect(rules).toHaveLength(1);
		expect(rules[0]!.gist).toBe("first message.");
	});

	it("recognizes the inline `rule (lint/...)` form and falls back to the leaf gist", () => {
		const rules = parseBiomeRules("noEnum (lint/style/noEnum)");
		expect(rules).toEqual([{ rule: "lint/style/noEnum", gist: "noEnum" }]);
	});
});

describe("extractConstraints — biome", () => {
	it("turns each distinct biome rule into a `biome: <rule> — <gist>` constraint", () => {
		const { constraints } = extractConstraints(BIOME_OUTPUT);
		const texts = constraints.map((c) => c.text);
		expect(constraints.map((c) => c.id)).toEqual(["biome:lint/style/noEnum", "biome:lint/suspicious/noExplicitAny"]);
		expect(texts[0]).toBe("biome: lint/style/noEnum — Use a union of string literals instead of an enum.");
	});
});

describe("parseTypeScriptErrors + extractConstraints — TS codes", () => {
	it("parses every `error TS####:` occurrence with its message", () => {
		const out = "a.ts(1,1): error TS2322: Type 'x' is not assignable to type 'y'.";
		expect(parseTypeScriptErrors(out)).toEqual([
			{ code: "TS2322", message: "Type 'x' is not assignable to type 'y'." },
		]);
	});

	it("does NOT emit a constraint for a one-off TS code (appears once, no history)", () => {
		const out = "a.ts(1,1): error TS2322: Type 'x' is not assignable to type 'y'.";
		const { constraints } = extractConstraints(out);
		expect(constraints).toHaveLength(0);
	});

	it("emits a constraint when the same code appears >=2 times in ONE output", () => {
		const out = [
			"a.ts(1,1): error TS2322: Type 'x' is not assignable to type 'y'.",
			"b.ts(4,2): error TS2322: Type 'p' is not assignable to type 'q'.",
		].join("\n");
		const { constraints } = extractConstraints(out);
		expect(constraints.map((c) => c.id)).toEqual(["ts:TS2322"]);
		expect(constraints[0]!.text).toBe("TS2322: Type 'x' is not assignable to type 'y'.");
	});

	it("emits a constraint when a code recurs ACROSS cycles via the threaded counter", () => {
		const out = "a.ts(1,1): error TS2531: Object is possibly 'null'.";
		const first = extractConstraints(out); // count now 1 — no constraint yet
		expect(first.constraints).toHaveLength(0);
		const second = extractConstraints(out, first.tsCounts); // cumulative 2 — emit
		expect(second.constraints.map((c) => c.id)).toEqual(["ts:TS2531"]);
	});
});

describe("extractConstraints — TS1294 erasableSyntaxOnly special case", () => {
	it("emits the fixed erasable-syntax constraint on FIRST sight (bypasses recurrence)", () => {
		const out = "a.ts(1,1): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.";
		const { constraints } = extractConstraints(out);
		expect(constraints).toHaveLength(1);
		expect(constraints[0]!.id).toBe("ts:erasable-syntax");
		expect(constraints[0]!.text).toContain("erasableSyntaxOnly (TS1294)");
		// The generic `ts:TS1294` constraint is intentionally NOT also emitted.
		expect(constraints.some((c) => c.id === "ts:TS1294")).toBe(false);
	});
});

describe("SessionContract — dedupe, hits, cap, expiry", () => {
	beforeEach(() => resetRuntimeDiagnostics());

	it("dedupes by id and bumps hits on a repeat violation", () => {
		const c = new SessionContract();
		c.add(ec("biome:lint/style/noEnum"));
		c.add(ec("biome:lint/style/noEnum"));
		expect(c.size()).toBe(1);
		expect(c.list()[0]!.hits).toBe(2);
	});

	it("caps at MAX_CONSTRAINTS and prefers higher-hit constraints when full", () => {
		const c = new SessionContract();
		// Five distinct constraints; bump the first four to hits=2, leave the 5th at 1.
		for (let i = 0; i < MAX_CONSTRAINTS; i++) c.add(ec(`r${i}`));
		for (let i = 0; i < MAX_CONSTRAINTS - 1; i++) c.add(ec(`r${i}`));
		expect(c.size()).toBe(MAX_CONSTRAINTS);
		// A sixth (hits=1) displaces the sole hits=1 incumbent (r4), keeping the strong ones.
		c.add(ec("r-new"));
		const ids = new Set(c.list().map((x) => x.id));
		expect(ids.has("r-new")).toBe(true);
		expect(ids.has("r4")).toBe(false);
		expect(ids.has("r0")).toBe(true);
		// When every incumbent is stronger (hits>=2), a fresh one-off is dropped.
		c.add(ec("r-new")); // bump r-new to hits=2 so all five are >=2 now
		c.add(ec("r-loser"));
		expect(c.list().some((x) => x.id === "r-loser")).toBe(false);
		expect(c.size()).toBe(MAX_CONSTRAINTS);
	});

	it("expires a constraint after EXPIRY_PASSES consecutive passes without re-firing", () => {
		const c = new SessionContract();
		c.add(ec("biome:lint/style/noEnum"));
		for (let i = 0; i < EXPIRY_PASSES - 1; i++) c.noteVerificationPass();
		expect(c.size()).toBe(1); // still alive one pass short of expiry
		c.noteVerificationPass();
		expect(c.size()).toBe(0);
	});

	it("resets the pass counter when a constraint re-fires", () => {
		const c = new SessionContract();
		c.add(ec("biome:lint/style/noEnum"));
		c.noteVerificationPass();
		c.noteVerificationPass(); // 2 passes accrued
		c.add(ec("biome:lint/style/noEnum")); // re-fire → reset
		c.noteVerificationPass();
		c.noteVerificationPass(); // only 2 again → still alive
		expect(c.size()).toBe(1);
		c.noteVerificationPass();
		expect(c.size()).toBe(0);
	});

	it("ingestCheckFailure dedupes an identical output (idempotent re-summarize)", () => {
		const c = new SessionContract();
		c.ingestCheckFailure(BIOME_OUTPUT);
		c.ingestCheckFailure(BIOME_OUTPUT); // same output → no double bump
		expect(c.list().every((x) => x.hits === 1)).toBe(true);
	});
});

describe("formatSessionContractBlock — render / omit", () => {
	it("returns empty string when there are no constraints", () => {
		expect(formatSessionContractBlock([])).toBe("");
	});

	it("renders one imperative line per constraint, highest-hit first", () => {
		const block = formatSessionContractBlock([tracked("low", 1, 0), tracked("high", 3, 1)]);
		expect(block.startsWith("<session_contract>")).toBe(true);
		expect(block.endsWith("</session_contract>")).toBe(true);
		const lines = block.split("\n").filter((l) => l.trim().startsWith("- "));
		expect(lines).toEqual(["  - high", "  - low"]);
	});
});

describe("module registry", () => {
	afterEach(() => setCurrentSessionContract(undefined));

	it("set/get round-trips the active contract (verification.ts:357 pattern)", () => {
		expect(getCurrentSessionContract()).toBeUndefined();
		const c = new SessionContract();
		setCurrentSessionContract(c);
		expect(getCurrentSessionContract()).toBe(c);
		setCurrentSessionContract(undefined);
		expect(getCurrentSessionContract()).toBeUndefined();
	});
});

describe("diagnostics", () => {
	beforeEach(() => resetRuntimeDiagnostics());

	it("emits a quality.contract diagnostic with ruleId when a constraint is added", () => {
		const c = new SessionContract();
		c.add(ec("biome:lint/style/noEnum"));
		const events = getRuntimeDiagnostics().recent.filter((e) => e.category === "quality.contract");
		expect(events).toHaveLength(1);
		expect(events[0]!.context?.ruleId).toBe("biome:lint/style/noEnum");
		expect(events[0]!.source).toBe("session-contract");
	});

	it("emits again (refreshed) on a repeat violation", () => {
		const c = new SessionContract();
		c.add(ec("biome:lint/style/noEnum"));
		c.add(ec("biome:lint/style/noEnum"));
		const events = getRuntimeDiagnostics().recent.filter((e) => e.category === "quality.contract");
		expect(events).toHaveLength(2);
		expect(events[1]!.context?.note).toContain("refreshed");
	});
});
