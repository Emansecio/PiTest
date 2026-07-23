/**
 * P5 `/pin` — context immune to forgetting.
 *
 * Two halves:
 *  1. PinManager state machine (caps, dedupe, unpin authority, serialize/restore,
 *     the per-turn <pinned> section and the compaction summary footer).
 *  2. The load-bearing part — file pins make a path's tool-results immune to
 *     supersede, size-prune and mutation-arg elision in the shared prune
 *     pipeline, and the pin-less path stays byte-identical.
 */
import { join } from "node:path";
import type { AgentMessage } from "@pit/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { applySupersedeOnly, planContextPrune, pruneOldToolOutputs } from "../src/core/compaction/compaction.js";
import { setCurrentDeferredOutputStore } from "../src/core/deferred-output-store.js";
import { PIN_CAP, PIN_FACT_MAX, PinManager } from "../src/core/pins.js";

const PRUNE_TOKEN_THRESHOLD = 20_000;

afterEach(() => {
	setCurrentDeferredOutputStore(undefined);
});

// ---------------------------------------------------------------------------
// Synthetic-window helpers (same shape as supersede-machine.test.ts).
// ---------------------------------------------------------------------------

/** Multi-line blob above the head+tail excerpt budget but below the 20k size threshold. */
function bigBlob(head = "HEAD_MARKER", tail = "TAIL_MARKER"): string {
	return `${head}\n${"filler line\n".repeat(800)}${tail}`;
}

/** Blob whose dense token estimate exceeds the 20k size-prune threshold. */
function hugeBlob(): string {
	return `HEAD\n${"filler filler filler line\n".repeat(6000)}TAIL`;
}

function toolCall(name: string, id: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		timestamp: 1,
	} as unknown as AgentMessage;
}

function toolResult(toolName: string, toolCallId: string, text: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 1,
	} as unknown as AgentMessage;
}

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as unknown as AgentMessage;
}

function textAt(messages: AgentMessage[], i: number): string {
	return (messages[i] as unknown as { content: { text: string }[] }).content[0].text;
}

function argsAt(messages: AgentMessage[], i: number): Record<string, unknown> {
	return (messages[i] as unknown as { content: { arguments: Record<string, unknown> }[] }).content[0].arguments;
}

function sorted(set: Set<number>): number[] {
	return [...set].sort((a, b) => a - b);
}

function pinPaths(...abs: string[]): ReadonlySet<string> {
	const pins = new PinManager();
	for (const p of abs) pins.pinFile(p, process.cwd(), "user");
	return pins.pinnedCanonicalPaths();
}

// ===========================================================================
// PinManager state machine
// ===========================================================================

describe("PinManager — facts", () => {
	it("pins a fact, assigns a stable p<N> id, and lists it", () => {
		const pins = new PinManager();
		const a = pins.pinFact("never touch CHANGELOG.md", "user");
		const b = pins.pinFact("the wire format is frozen", "model");
		expect(a.id).toBe("p1");
		expect(b.id).toBe("p2");
		expect(pins.list().map((p) => p.id)).toEqual(["p1", "p2"]);
		expect(a.kind).toBe("fact");
		expect(a.createdBy).toBe("user");
	});

	it("truncates a fact to the cap on create", () => {
		const pins = new PinManager();
		const item = pins.pinFact("x".repeat(PIN_FACT_MAX + 200), "user");
		expect(item.text?.length).toBeLessThanOrEqual(PIN_FACT_MAX);
	});

	it("rejects an empty fact", () => {
		const pins = new PinManager();
		expect(() => pins.pinFact("   ", "user")).toThrow();
	});

	it("throws a legible error past the cap", () => {
		const pins = new PinManager();
		for (let i = 0; i < PIN_CAP; i++) pins.pinFact(`fact ${i}`, "user");
		expect(() => pins.pinFact("one too many", "user")).toThrow(/limit/i);
		expect(pins.list()).toHaveLength(PIN_CAP);
	});
});

describe("PinManager — files", () => {
	it("canonicalizes and dedupes by path (returns the existing item, no new id)", () => {
		const pins = new PinManager();
		const abs = join(process.cwd(), "src", "foo.ts");
		const first = pins.pinFile(abs, process.cwd(), "user");
		const again = pins.pinFile(abs, process.cwd(), "model");
		expect(again.id).toBe(first.id);
		expect(pins.list()).toHaveLength(1);
		expect(first.displayPath).toBe("src/foo.ts");
		expect(pins.pinnedCanonicalPaths().has(first.canonicalPath as string)).toBe(true);
	});

	it("dedupe survives relative/absolute spelling of the same file", () => {
		const pins = new PinManager();
		const rel = pins.pinFile(join(process.cwd(), "a.ts"), process.cwd(), "user");
		// A second pin of the same file (already absolute) must not add a row.
		pins.pinFile(join(process.cwd(), "a.ts"), process.cwd(), "user");
		expect(pins.list()).toHaveLength(1);
		expect(rel.kind).toBe("file");
	});
});

describe("PinManager — unpin authority", () => {
	it("the model cannot remove a user-created pin", () => {
		const pins = new PinManager();
		const userPin = pins.pinFact("owned by the human", "user");
		expect(pins.unpin(userPin.id, "model")).toBe(false);
		expect(pins.list()).toHaveLength(1);
		expect(pins.unpin(userPin.id, "user")).toBe(true);
		expect(pins.list()).toHaveLength(0);
	});

	it("the model may remove its own pin, and unknown ids return false", () => {
		const pins = new PinManager();
		const modelPin = pins.pinFact("model note", "model");
		expect(pins.unpin("nope", "model")).toBe(false);
		expect(pins.unpin(modelPin.id, "model")).toBe(true);
		expect(pins.isEmpty()).toBe(true);
	});
});

describe("PinManager — serialize/restore", () => {
	it("serialize is undefined when empty", () => {
		expect(new PinManager().serialize()).toBeUndefined();
	});

	it("round-trips items and the id counter, and never reissues an id", () => {
		const pins = new PinManager();
		pins.pinFact("f1", "user");
		pins.pinFile(join(process.cwd(), "b.ts"), process.cwd(), "model");
		const snap = pins.serialize();
		expect(snap).toBeDefined();

		const restored = new PinManager();
		restored.restore(snap);
		expect(restored.list().map((p) => p.id)).toEqual(["p1", "p2"]);
		// The next created pin continues the counter rather than colliding.
		expect(restored.pinFact("f3", "user").id).toBe("p3");
	});

	it("drops malformed rows and repairs the counter on restore", () => {
		const restored = new PinManager();
		restored.restore({
			items: [
				{ id: "p5", kind: "fact", text: "ok", createdBy: "user" },
				{ id: "p6", kind: "file" } as never, // no canonicalPath — dropped
				{ kind: "fact", text: "no id" } as never, // no id — dropped
			],
			nextId: 2,
		});
		expect(restored.list().map((p) => p.id)).toEqual(["p5"]);
		expect(restored.pinFact("next", "user").id).toBe("p6");
	});
});

describe("PinManager — prompt surfaces", () => {
	it("systemPromptSection / summaryFooter are undefined when empty", () => {
		const pins = new PinManager();
		expect(pins.systemPromptSection()).toBeUndefined();
		expect(pins.summaryFooter()).toBeUndefined();
	});

	it("systemPromptSection renders facts and a file list in a <pinned> block", () => {
		const pins = new PinManager();
		pins.pinFact("never touch CHANGELOG.md", "user");
		pins.pinFile(join(process.cwd(), "src", "core.ts"), process.cwd(), "user");
		const section = pins.systemPromptSection() as string;
		expect(section.startsWith("<pinned>")).toBe(true);
		expect(section.endsWith("</pinned>")).toBe(true);
		expect(section).toContain("never touch CHANGELOG.md");
		expect(section).toContain("src/core.ts");
	});

	it("summaryFooter is a compact one-block digest of facts and files", () => {
		const pins = new PinManager();
		pins.pinFact("frozen wire format", "user");
		pins.pinFile(join(process.cwd(), "x.ts"), process.cwd(), "user");
		const footer = pins.summaryFooter() as string;
		expect(footer).toContain("Pinned");
		expect(footer).toContain("frozen wire format");
		expect(footer).toContain("x.ts");
	});
});

// ===========================================================================
// Prune-pipeline immunity (the load-bearing half)
// ===========================================================================

/** Two files, each read twice → older read of each is a supersede candidate. */
function dupReadWindow(): AgentMessage[] {
	return [
		toolCall("read", "c1", { path: "pin-foo.ts" }),
		toolResult("read", "c1", bigBlob("FOO_OLD")),
		toolCall("read", "c2", { path: "pin-foo.ts" }),
		toolResult("read", "c2", "fresh foo"),
		toolCall("read", "c3", { path: "pin-bar.ts" }),
		toolResult("read", "c3", bigBlob("BAR_OLD")),
		toolCall("read", "c4", { path: "pin-bar.ts" }),
		toolResult("read", "c4", "fresh bar"),
		user("a"),
		user("b"),
	];
}

describe("file pins — supersede immunity", () => {
	it("without pins, both older duplicate reads are superseded (baseline)", () => {
		const messages = dupReadWindow();
		expect(sorted(planContextPrune(messages, 2).supersededIndices)).toEqual([1, 5]);
	});

	it("an empty pinned set is byte-identical to the no-arg plan", () => {
		const messages = dupReadWindow();
		const base = planContextPrune(messages, 2);
		const withEmpty = planContextPrune(dupReadWindow(), 2, new Set());
		expect(sorted(withEmpty.supersededIndices)).toEqual(sorted(base.supersededIndices));
		expect(withEmpty.pinnedIndices.size).toBe(0);
	});

	it("a pinned path's older read survives where the unpinned one is superseded", () => {
		const messages = dupReadWindow();
		const pinnedPaths = pinPaths(join(process.cwd(), "pin-foo.ts"));
		const plan = planContextPrune(messages, 2, pinnedPaths);

		// foo's stale read (index 1) is protected; bar's (index 5) still collapses.
		expect(sorted(plan.supersededIndices)).toEqual([5]);
		// The pinned tool-results (both foo reads) are in the immune set.
		expect(sorted(plan.pinnedIndices)).toEqual([1, 3]);

		const reclaimed = applySupersedeOnly(messages, 2, plan);
		expect(reclaimed).toBeGreaterThan(0);
		expect(textAt(messages, 1)).toBe(bigBlob("FOO_OLD")); // pinned — untouched
		expect(textAt(messages, 5).length).toBeLessThan(bigBlob("BAR_OLD").length); // collapsed
	});
});

describe("file pins — size-prune immunity", () => {
	function hugeReadWindow(): AgentMessage[] {
		return [
			toolCall("read", "c1", { path: "pin-huge.ts" }),
			toolResult("read", "c1", hugeBlob()),
			user("a"),
			user("b"),
		];
	}

	it("without pins, a huge read is shrunk by size-prune (baseline)", () => {
		const messages = hugeReadWindow();
		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2);
		expect(reclaimed).toBeGreaterThan(0);
		expect(textAt(messages, 1).length).toBeLessThan(hugeBlob().length);
	});

	it("a pinned huge read is left intact", () => {
		const messages = hugeReadWindow();
		const plan = planContextPrune(messages, 2, pinPaths(join(process.cwd(), "pin-huge.ts")));
		expect(sorted(plan.pinnedIndices)).toEqual([1]);
		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2, false, plan);
		expect(reclaimed).toBe(0);
		expect(textAt(messages, 1)).toBe(hugeBlob());
	});
});

describe("file pins — mutation-arg elision immunity", () => {
	function bigWriteWindow(): AgentMessage[] {
		return [
			toolCall("write", "c1", { path: "pin-edit.ts", content: hugeBlob() }),
			toolResult("write", "c1", "written"),
			user("a"),
			user("b"),
		];
	}

	it("without pins, a stale write's heavy args are elided (baseline)", () => {
		const messages = bigWriteWindow();
		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2);
		expect(reclaimed).toBeGreaterThan(0);
		expect(String(argsAt(messages, 0).content).length).toBeLessThan(hugeBlob().length);
	});

	it("a pinned file's write args survive elision", () => {
		const messages = bigWriteWindow();
		const plan = planContextPrune(messages, 2, pinPaths(join(process.cwd(), "pin-edit.ts")));
		// Both the assistant call (index 0, for elision) and its result (index 1) are protected.
		expect(sorted(plan.pinnedIndices)).toEqual([0, 1]);
		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2, false, plan);
		expect(reclaimed).toBe(0);
		expect(argsAt(messages, 0).content).toBe(hugeBlob());
	});
});
