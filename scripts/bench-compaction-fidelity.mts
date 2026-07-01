/**
 * Compaction fidelity benchmark (deterministic, no provider calls).
 *
 * Measures the QUALITY of compaction outputs — not tokens — so changes to the
 * verify pass (F1) and summary grounding (F2) ship under a regression gate.
 * Today only token benches are gated; this adds three fidelity axes:
 *
 *   - structural_fact_recall_pct: % of planted real file paths that survive
 *     into the deterministic structural frame (formatFileOperations). A drop
 *     means the operation-list extraction regressed and the post-compaction
 *     model loses its artifact trail.
 *   - fabricated_paths_flagged: how many fabricated (not-touched, not-on-disk)
 *     paths the grounding layer annotates `(unverified)`. A drop means
 *     compaction hallucinations slip through unmarked.
 *   - ungrounded_false_positive: legitimate paths (touched or on disk) the
 *     grounding layer WRONGLY marks. Must stay 0 — a false positive is worse
 *     than a missed fabrication.
 *
 * Deterministic by construction: pure functions over synthetic messages with
 * planted facts, run against the repo root so the real file paths exist on
 * disk. Emits METRIC lines for scripts/check-token-bench.mjs.
 *
 * Usage: npx tsx scripts/bench-compaction-fidelity.mts
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@pit/agent-core";
import {
	computeOperationLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
	type OperationLists,
} from "../packages/coding-agent/src/core/compaction/utils.ts";
import { groundSummaryPaths } from "../packages/coding-agent/src/core/compaction/summary-grounding.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(join(here, ".."));

type ScenarioName = "edit-heavy" | "explore-heavy";

/** Real repo files that exist on disk AND are touched by the synthetic tool calls. */
const PLANTED_PATHS: Record<ScenarioName, string[]> = {
	"edit-heavy": [
		"packages/coding-agent/src/core/compaction/compaction.ts",
		"packages/coding-agent/src/core/agent-session-compaction.ts",
		"packages/coding-agent/src/core/compaction/utils.ts",
	],
	"explore-heavy": [
		"packages/coding-agent/src/core/compaction/compaction.ts",
		"packages/coding-agent/src/core/compaction/summary-grounding.ts",
		"packages/coding-agent/src/core/compaction/file-digests.ts",
	],
};

/** Paths that were never touched and do not exist on disk — must be flagged. */
const FABRICATED_PATHS = [
	"src/fabricated/ghost.ts",
	"packages/coding-agent/src/core/nonexistent-module.ts",
];

function assistantToolCall(name: "edit" | "read", id: string, path: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: { path } }],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	} as AgentMessage;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistantText(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	} as AgentMessage;
}

/** Build synthetic messages whose tool calls touch the planted paths. */
function buildScenarioMessages(scenario: ScenarioName): AgentMessage[] {
	const toolName = scenario === "edit-heavy" ? "edit" : "read";
	const paths = PLANTED_PATHS[scenario];
	const messages: AgentMessage[] = [userMessage("Fix the compaction verify pass and ground the summary.")];
	for (let i = 0; i < paths.length; i++) {
		messages.push(assistantToolCall(toolName, `tc-${scenario}-${i}`, paths[i]));
	}
	messages.push(assistantText("Done with the pass."));
	return messages;
}

/** Synthetic summary prose citing the planted paths (legit) + fabricated paths. */
function buildSyntheticSummary(scenario: ScenarioName): string {
	const planted = PLANTED_PATHS[scenario];
	const doneLines = planted.map((p) => `- [x] ${scenario === "edit-heavy" ? "Edited" : "Read"} ${p}`).join("\n");
	const fabricatedLines = FABRICATED_PATHS.map((p) => `- Touched ${p}`).join("\n");
	return [
		"## Goal",
		"Fix the compaction verify pass and add deterministic summary grounding.",
		"",
		"## Constraints & Preferences",
		"- No regressions in the token-economy gate",
		"- Default native for every provider",
		"",
		"## Progress",
		"### Done",
		doneLines,
		fabricatedLines,
		"",
		"## Key Decisions",
		"- **Verify against source**: the self-correction pass must see the conversation-delta",
		"- **Annotate, never delete**: ungrounded paths get (unverified)",
		"",
		"## Critical Context",
		"- Error: TypeError in verifySummary — missing source argument (fixed)",
	].join("\n");
}

interface FidelityMetrics {
	scenario: ScenarioName;
	structuralFactRecallPct: number;
	fabricatedPathsFlagged: number;
	ungroundedFalsePositive: number;
}

function measureScenario(scenario: ScenarioName): FidelityMetrics {
	const messages = buildScenarioMessages(scenario);
	const fileOps = createFileOps();
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}
	const lists: OperationLists = computeOperationLists(fileOps, repoRoot);
	const frame = formatFileOperations(lists);

	// Structural recall: planted paths present in the deterministic frame.
	const planted = PLANTED_PATHS[scenario];
	let recalled = 0;
	for (const p of planted) {
		if (frame.includes(p)) recalled++;
	}
	const structuralFactRecallPct = Math.round((recalled / planted.length) * 100);

	// Grounding: run over the synthetic prose. Planted paths are legit (lists +
	// on disk); fabricated paths must be flagged, planted paths must NOT be.
	const summary = buildSyntheticSummary(scenario);
	const grounded = groundSummaryPaths(summary, lists, repoRoot);

	const plantedSet = new Set(planted.map((p) => p.replace(/\\/g, "/")));
	const fabricatedSet = new Set(FABRICATED_PATHS.map((p) => p.replace(/\\/g, "/")));

	let fabricatedPathsFlagged = 0;
	let ungroundedFalsePositive = 0;
	for (const flagged of grounded.ungroundedPaths) {
		const norm = flagged.replace(/\\/g, "/");
		if (fabricatedSet.has(norm)) {
			fabricatedPathsFlagged++;
		} else if (plantedSet.has(norm)) {
			ungroundedFalsePositive++;
		} else {
			// Unknown third path — neither planted nor fabricated. Treat as a false
			// positive (the layer flagged something it should not have).
			ungroundedFalsePositive++;
		}
	}

	// Sanity: confirm planted paths actually exist on disk so the filesystem
	// fallback path is exercised (and the bench is not silently lying).
	for (const p of planted) {
		if (!existsSync(resolve(repoRoot, p))) {
			throw new Error(`bench-compaction-fidelity: planted path missing on disk: ${p}`);
		}
	}

	return { scenario, structuralFactRecallPct, fabricatedPathsFlagged, ungroundedFalsePositive };
}

function printMetrics(m: FidelityMetrics): void {
	console.log(`\n=== compaction-fidelity:${m.scenario} ===`);
	console.log(`structural_fact_recall_pct: ${m.structuralFactRecallPct}`);
	console.log(`fabricated_paths_flagged:   ${m.fabricatedPathsFlagged} / ${FABRICATED_PATHS.length}`);
	console.log(`ungrounded_false_positive:  ${m.ungroundedFalsePositive}`);
	console.log(`METRIC scenario=${m.scenario} bench=compaction-fidelity structural_fact_recall_pct=${m.structuralFactRecallPct}`);
	console.log(`METRIC scenario=${m.scenario} bench=compaction-fidelity fabricated_paths_flagged=${m.fabricatedPathsFlagged}`);
	console.log(`METRIC scenario=${m.scenario} bench=compaction-fidelity ungrounded_false_positive=${m.ungroundedFalsePositive}`);
}

const scenarios: ScenarioName[] = ["edit-heavy", "explore-heavy"];
console.log("bench-compaction-fidelity (deterministic, no provider)");
console.log(`METRIC bench=compaction-fidelity scenarios=${scenarios.join(",")}`);
for (const scenario of scenarios) {
	printMetrics(measureScenario(scenario));
}
