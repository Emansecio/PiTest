// suggestClosest from @pit/ai is the REAL fuzzy matcher used in production.
// Using the real one (not a stub) makes the rewrite/block thresholds load-bearing.
import { suggestClosest } from "@pit/ai";
import { describe, expect, it } from "vitest";
import {
	GROUNDING_GUARD_DEFAULTS,
	type GroundingCandidate,
	type GroundingGuardDeps,
	groundToolCall,
	isGroundingGuardDisabled,
	repoMapToSymbolSet,
	type SymbolNameSet,
} from "../src/core/grounding-guard.ts";
import type { LivingRepoMap } from "../src/core/repo-map/living-index.ts";

const REAL_FUZZY = suggestClosest;

/** Build a SymbolNameSet from original-cased names (mirrors repoMapToSymbolSet). */
function symbols(...names: string[]): SymbolNameSet {
	return { names: new Set(names), lowerSet: new Set(names.map((n) => n.toLowerCase())) };
}

// Use the PRODUCTION thresholds (maxDistance 3, prefixMinOverlap 64 = affix fallback
// disabled) so the tests exercise what the wire actually configures, not a stub.
function makeDeps(overrides: Partial<GroundingGuardDeps> = {}): GroundingGuardDeps {
	return {
		indexLookup: async () => symbols(),
		lspResolve: undefined,
		fuzzy: REAL_FUZZY,
		maxDistance: GROUNDING_GUARD_DEFAULTS.maxDistance,
		prefixMinOverlap: GROUNDING_GUARD_DEFAULTS.prefixMinOverlap,
		...overrides,
	};
}

// The two GROUNDABLE shapes: a global function-breakpoint name, and a workspace
// symbol search (action=symbols, file="*", query = a global name).
const debugBreakpoint = (fn: string): GroundingCandidate => ({
	toolName: "debug",
	args: { action: "set_breakpoint", function: fn },
});
const symbolsQuery = (query: string): GroundingCandidate => ({
	toolName: "lsp",
	args: { action: "symbols", file: "*", query },
});

describe("groundToolCall — invariant 1: cascade (repo-map -> LSP) before block", () => {
	it("repo-map fast-path hit allows WITHOUT ever consulting the LSP", async () => {
		let lspCalls = 0;
		const decision = await groundToolCall(symbolsQuery("calculateTotal"), {
			...makeDeps(),
			indexLookup: async () => symbols("calculateTotal", "other"),
			lspResolve: async () => {
				lspCalls++;
				return [];
			},
		});
		expect(decision).toEqual({ action: "allow" });
		// Load-bearing: a repo-map hit must short-circuit; the authoritative LSP is
		// only for MISSES. If this regressed to always-LSP, lspCalls would be 1.
		expect(lspCalls).toBe(0);
	});

	it("repo-map MISS falls through to the LSP and allows when the LSP confirms (lossy index gap)", async () => {
		let lspCalls = 0;
		const decision = await groundToolCall(debugBreakpoint("ClassMember"), {
			...makeDeps(),
			// Index is LOSSY (top-level cap) and does NOT carry the symbol...
			indexLookup: async () => symbols("unrelated"),
			// ...but the authoritative LSP knows it exactly -> must NOT block.
			lspResolve: async () => {
				lspCalls++;
				return ["ClassMember"];
			},
		});
		expect(lspCalls).toBe(1);
		expect(decision).toEqual({ action: "allow" });
	});

	it("blocks ONLY after BOTH index miss AND LSP answers without the exact name", async () => {
		const decision = await groundToolCall(symbolsQuery("calculateTotal"), {
			...makeDeps(),
			indexLookup: async () => symbols("irrelevant"),
			// LSP answers (array, not undefined) and the exact name is absent ->
			// authoritative absence. Two near (distance-1) candidates -> BLOCK.
			lspResolve: async () => ["calculateTotai", "calculateTotat"],
		});
		expect(decision.action).toBe("block");
	});
});

describe("groundToolCall — invariant 2: global references only, never line-scoped/definitions", () => {
	it("auto-fixes a single dominant candidate (rewrite), preserving other args", async () => {
		const decision = await groundToolCall(symbolsQuery("calculateTotl"), {
			...makeDeps(),
			indexLookup: async () => symbols("calculateTotal"),
			lspResolve: async () => [], // answered-but-empty -> absence confirmed
		});
		expect(decision.action).toBe("rewrite");
		if (decision.action !== "rewrite") throw new Error("expected rewrite");
		// The reference arg is corrected to the dominant candidate...
		expect(decision.args.query).toBe("calculateTotal");
		// ...and unrelated args are carried through untouched.
		expect(decision.args.action).toBe("symbols");
		expect(decision.args.file).toBe("*");
	});

	it("NEVER grounds the line-scoped `symbol` of lsp navigation (locals/members/params)", async () => {
		// The `symbol` of definition/references/rename is a per-LINE column selector
		// (resolveSymbolColumn), NOT a global name — it legitimately names a local,
		// param, member or alias. Grounding it would false-block/rewrite. Even with a
		// fuzzy-close global candidate sitting in the index, this must be left alone.
		let indexCalls = 0;
		let lspCalls = 0;
		for (const action of ["definition", "type_definition", "implementation", "references", "rename"]) {
			const decision = await groundToolCall(
				{ toolName: "lsp", args: { action, symbol: "totl", file: "src/foo.ts", line: 42 } },
				{
					...makeDeps(),
					indexLookup: async () => {
						indexCalls++;
						return symbols("total");
					},
					lspResolve: async () => {
						lspCalls++;
						return [];
					},
				},
			);
			expect(decision).toEqual({ action: "allow" });
		}
		// Not a groundable target -> short-circuited before any I/O.
		expect(indexCalls).toBe(0);
		expect(lspCalls).toBe(0);
	});

	it("NEVER touches new_name on rename — that is a DEFINITION, and rename is out of scope", async () => {
		const candidate: GroundingCandidate = {
			toolName: "lsp",
			args: { action: "rename", symbol: "calculateTotal", new_name: "computeGrandTotalXyz", file: "src/a.ts" },
		};
		const decision = await groundToolCall(candidate, {
			...makeDeps(),
			indexLookup: async () => {
				throw new Error("rename is not a groundable target — deps must not be consulted");
			},
		});
		expect(decision).toEqual({ action: "allow" });
	});

	it("ignores rename_file (new_name is a destination PATH, never grounded)", async () => {
		const candidate: GroundingCandidate = {
			toolName: "lsp",
			args: { action: "rename_file", file: "src/old.ts", new_name: "src/new.ts" },
		};
		const decision = await groundToolCall(candidate, makeDeps());
		expect(decision).toEqual({ action: "allow" });
	});
});

describe("groundToolCall — invariant 3: fail-open on missing infra / throws", () => {
	it("no LSP wired (lspResolve undefined) -> never blocks on an index miss", async () => {
		const decision = await groundToolCall(symbolsQuery("totallyMadeUpSymbol"), {
			...makeDeps(),
			indexLookup: async () => symbols("something"),
			lspResolve: undefined,
		});
		// Cannot prove absence without the authority -> FAIL-OPEN.
		expect(decision).toEqual({ action: "allow" });
	});

	it("LSP returning undefined (errored/unavailable) -> fail-open, not block", async () => {
		const decision = await groundToolCall(symbolsQuery("madeUpName"), {
			...makeDeps(),
			indexLookup: async () => symbols("realThing"),
			lspResolve: async () => undefined, // could-not-answer
		});
		expect(decision).toEqual({ action: "allow" });
	});

	it("a throw in the index lookup is swallowed; LSP can still resolve", async () => {
		const decision = await groundToolCall(debugBreakpoint("knownSym"), {
			...makeDeps(),
			indexLookup: async () => {
				throw new Error("index exploded");
			},
			lspResolve: async () => ["knownSym"],
		});
		expect(decision).toEqual({ action: "allow" });
	});

	it("a throw in lspResolve is swallowed -> fail-open", async () => {
		const decision = await groundToolCall(symbolsQuery("madeUpName"), {
			...makeDeps(),
			indexLookup: async () => symbols("other"),
			lspResolve: async () => {
				throw new Error("LSP crashed");
			},
		});
		expect(decision).toEqual({ action: "allow" });
	});

	it("a throw in the fuzzy matcher is swallowed -> fail-open (never wedges)", async () => {
		const decision = await groundToolCall(symbolsQuery("madeUpName"), {
			...makeDeps(),
			indexLookup: async () => symbols("alphaName"),
			lspResolve: async () => ["betaName", "gammaName"],
			fuzzy: () => {
				throw new Error("fuzzy boom");
			},
		});
		expect(decision).toEqual({ action: "allow" });
	});

	it("PIT_NO_GROUNDING_GUARD opt-out is honored by isGroundingGuardDisabled", () => {
		expect(isGroundingGuardDisabled({ PIT_NO_GROUNDING_GUARD: "1" })).toBe(true);
		expect(isGroundingGuardDisabled({ PIT_NO_GROUNDING_GUARD: "true" })).toBe(true);
		expect(isGroundingGuardDisabled({ PIT_NO_GROUNDING_GUARD: "yes" })).toBe(true);
		expect(isGroundingGuardDisabled({ PIT_NO_GROUNDING_GUARD: "0" })).toBe(false);
		expect(isGroundingGuardDisabled({})).toBe(false);
	});

	it("PIT_NO_GROUNDING (preferred alias) opt-out is honored by isGroundingGuardDisabled", () => {
		expect(isGroundingGuardDisabled({ PIT_NO_GROUNDING: "1" })).toBe(true);
		expect(isGroundingGuardDisabled({ PIT_NO_GROUNDING: "true" })).toBe(true);
		expect(isGroundingGuardDisabled({ PIT_NO_GROUNDING: "yes" })).toBe(true);
		expect(isGroundingGuardDisabled({ PIT_NO_GROUNDING: "0" })).toBe(false);
	});
});

describe("groundToolCall — debug function breakpoint (REFERENCE)", () => {
	it("blocks with candidates when the function name is absent", async () => {
		const decision = await groundToolCall(debugBreakpoint("calculateTotal"), {
			...makeDeps(),
			// Two names each one edit away from the query -> both within threshold.
			indexLookup: async () => symbols("calculateTotaI", "calculateTotaX"),
			lspResolve: async () => [],
		});
		expect(decision.action).toBe("block");
		if (decision.action !== "block") throw new Error("expected block");
		expect(decision.message).toContain("calculateTota");
		expect(decision.message).toContain("no write/exec attempted");
		expect(decision.message).toContain("Did you mean");
	});

	it("auto-fixes a function-breakpoint name with a single dominant candidate", async () => {
		const decision = await groundToolCall(debugBreakpoint("calculateTotl"), {
			...makeDeps(),
			indexLookup: async () => symbols("calculateTotal"),
			lspResolve: async () => [],
		});
		expect(decision.action).toBe("rewrite");
		if (decision.action !== "rewrite") throw new Error("expected rewrite");
		expect(decision.args.function).toBe("calculateTotal");
	});

	it("does NOT ground a debug breakpoint that uses file+line (not a function reference)", async () => {
		const candidate: GroundingCandidate = {
			toolName: "debug",
			args: { action: "set_breakpoint", file: "src/a.ts", line: 10, function: "shouldBeIgnored" },
		};
		const decision = await groundToolCall(candidate, {
			...makeDeps(),
			indexLookup: async () => symbols("other"),
			lspResolve: async () => [],
		});
		expect(decision).toEqual({ action: "allow" });
	});

	it("ignores debug actions that are not breakpoint-related", async () => {
		const candidate: GroundingCandidate = {
			toolName: "debug",
			args: { action: "evaluate", function: "anything" },
		};
		const decision = await groundToolCall(candidate, makeDeps());
		expect(decision).toEqual({ action: "allow" });
	});
});

describe("groundToolCall — lsp workspace symbol query gating", () => {
	it("does NOT ground query when file is a real path (scoped symbol listing, not a name)", async () => {
		const decision = await groundToolCall(
			{ toolName: "lsp", args: { action: "symbols", file: "src/foo.ts", query: "anything" } },
			{
				...makeDeps(),
				indexLookup: async () => symbols("other"),
				lspResolve: async () => [],
			},
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("does NOT ground query for action=code_actions (selector text, not a symbol)", async () => {
		const decision = await groundToolCall(
			{ toolName: "lsp", args: { action: "code_actions", file: "src/a.ts", query: "quickfix.import" } },
			makeDeps(),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("does NOT ground action=hover (tolerates a miss by design)", async () => {
		const decision = await groundToolCall(
			{ toolName: "lsp", args: { action: "hover", symbol: "madeUp", file: "src/a.ts", line: 1 } },
			{
				...makeDeps(),
				indexLookup: async () => symbols("other"),
				lspResolve: async () => [],
			},
		);
		expect(decision).toEqual({ action: "allow" });
	});
});

describe("groundToolCall — calibration: length floor + no affix fallback", () => {
	it("never grounds a short name (< floor), even when absent with close neighbours", async () => {
		const decision = await groundToolCall(debugBreakpoint("idx"), {
			...makeDeps(),
			indexLookup: async () => symbols("idxOf", "index"),
			lspResolve: async () => [],
		});
		// "idx" is 3 chars — below the floor — so it is left strictly alone.
		expect(decision).toEqual({ action: "allow" });
	});

	it("does NOT rewrite via the affix (substring) fallback — only true typos qualify", async () => {
		const decision = await groundToolCall(symbolsQuery("Total"), {
			...makeDeps(),
			// "Total" is a substring of "calculateTotal" but far in edit distance. With
			// the affix fallback disabled (prefixMinOverlap=64), no candidate qualifies.
			indexLookup: async () => symbols("calculateTotal"),
			lspResolve: async () => [],
		});
		expect(decision).toEqual({ action: "allow" });
	});

	it("index fast-path hit is CASE-INSENSITIVE — a case-variant short-circuits without the LSP", async () => {
		let lspCalls = 0;
		const decision = await groundToolCall(symbolsQuery("calculatetotal"), {
			...makeDeps(),
			indexLookup: async () => symbols("calculateTotal"),
			lspResolve: async () => {
				lspCalls++;
				return [];
			},
		});
		// A case-only variance of an indexed symbol must count as a hit (matching the
		// LSP/fuzzy layers), not slip through to a silent case rewrite.
		expect(decision).toEqual({ action: "allow" });
		expect(lspCalls).toBe(0);
	});

	it("does NOT ground a qualified name (pkg.Func / Class.method) — not a global simple identifier", async () => {
		for (const fn of ["main.run", "Server.Start", "a.b.c"]) {
			const decision = await groundToolCall(debugBreakpoint(fn), {
				...makeDeps(),
				indexLookup: async () => symbols("mainRun", "ServerStart"),
				lspResolve: async () => [],
			});
			expect(decision).toEqual({ action: "allow" });
		}
	});

	it("does NOT ground a multi-token / punctuated query", async () => {
		const decision = await groundToolCall(symbolsQuery("My Class"), {
			...makeDeps(),
			indexLookup: async () => symbols("MyClass"),
			lspResolve: async () => [],
		});
		expect(decision).toEqual({ action: "allow" });
	});

	it("does NOT ground debug remove_breakpoint (targets a SET breakpoint, not a live symbol)", async () => {
		const decision = await groundToolCall(
			{ toolName: "debug", args: { action: "remove_breakpoint", function: "calculateTotl" } },
			{
				...makeDeps(),
				indexLookup: async () => symbols("calculateTotal"),
				lspResolve: async () => [],
			},
		);
		expect(decision).toEqual({ action: "allow" });
	});
});

describe("groundToolCall — out-of-scope tools are ignored", () => {
	it("ignores non-target tools entirely", async () => {
		for (const toolName of ["read", "edit", "write", "grep", "bash", "find"]) {
			const decision = await groundToolCall(
				{ toolName, args: { symbol: "whatever", function: "whatever", query: "whatever" } },
				makeDeps(),
			);
			expect(decision).toEqual({ action: "allow" });
		}
	});

	it("allows when a single absent symbol has NO fuzzy-close candidate (no wedge)", async () => {
		const decision = await groundToolCall(symbolsQuery("zzzTotallyDistinct99"), {
			...makeDeps(),
			indexLookup: async () => symbols("alphaName", "betaName", "gammaName"),
			lspResolve: async () => [],
		});
		// Confirmed absent but nothing close -> allow (do not block legitimate names).
		expect(decision).toEqual({ action: "allow" });
	});
});

describe("repoMapToSymbolSet", () => {
	it("flattens entries' symbols into a deduped set", () => {
		const map: LivingRepoMap = {
			version: 4,
			lastIndexedCommit: "abc",
			entries: [
				{ path: "a.ts", symbols: ["foo", "bar"], mtimeMs: 1 },
				{ path: "b.ts", symbols: ["bar", "baz"], mtimeMs: 2 },
			],
		};
		const set = repoMapToSymbolSet(map);
		expect(set.names.has("foo")).toBe(true);
		expect(set.names.has("bar")).toBe(true);
		expect(set.names.has("baz")).toBe(true);
		expect(set.names.size).toBe(3);
		expect(set.lowerSet.has("foo")).toBe(true);
		expect(set.lowerSet.has("bar")).toBe(true);
		expect(set.lowerSet.size).toBe(3);
	});
});
