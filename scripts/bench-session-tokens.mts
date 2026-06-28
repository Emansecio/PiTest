/**
 * Synthetic multi-turn session token benchmark (no provider calls).
 *
 * Measures message payload, fixed prefix, wire proxy, and prune/supersede reclaim
 * for representative session shapes. Emits METRIC lines for autoresearch / CI.
 *
 * Usage:
 *   npx tsx scripts/bench-session-tokens.mts
 *   npx tsx scripts/bench-session-tokens.mts --scenario=explore-heavy
 *   npx tsx scripts/bench-session-tokens.mts --scenario=edit-heavy
 *   npx tsx scripts/bench-session-tokens.mts --scenario=long-reasoning
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@pit/agent-core";
import {
	adaptivePruneThreshold,
	applyOldThinkingCap,
	applySupersedeOnly,
	cloneToolResultMessagesForPrune,
	elideMutatingToolCallArguments,
	estimateTokens,
	estimateWireTokens,
	pressurePruneProtectTurns,
	pruneOldToolOutputs,
	proactivePruneFloor,
	type WireToolSurface,
} from "../packages/coding-agent/src/core/compaction/compaction.ts";
import { buildSystemPrompt } from "../packages/coding-agent/src/core/system-prompt.ts";
import { createAllTools } from "../packages/coding-agent/src/core/tools/index.ts";

const APPROX_CHARS_PER_TOKEN = 3.7;
const CONTEXT_WINDOW = 1_000_000;
const PROTECT_TURNS = 2;

const toToks = (chars: number) => Math.round(chars / APPROX_CHARS_PER_TOKEN);

type ScenarioName = "explore-heavy" | "edit-heavy" | "long-reasoning";

type ContextFile = { path: string; content: string };
type Skill = { name: string; description: string; filePath: string; disableModelInvocation?: boolean };

type ScenarioMetrics = {
	scenario: ScenarioName;
	messagesOnlyTokens: number;
	prefixTokens: number;
	wireEstimateTokens: number;
	afterPruneTokens: number;
	afterSupersedeTokens: number;
	afterLiveEconomyTokens: number;
	pruneReclaimedTokens: number;
	supersedeReclaimedTokens: number;
	liveEconomyReclaimedTokens: number;
	proactivePruneFloorTokens: number;
};

function parseScenarioArg(argv: string[]): ScenarioName | "all" {
	for (const arg of argv) {
		if (arg.startsWith("--scenario=")) {
			const value = arg.slice("--scenario=".length) as ScenarioName;
			if (value !== "explore-heavy" && value !== "edit-heavy" && value !== "long-reasoning") {
				throw new Error(`Unknown scenario: ${value}`);
			}
			return value;
		}
	}
	return "all";
}

function sumMessageTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const message of messages) total += estimateTokens(message);
	return total;
}

function toolCall(name: string, id: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		timestamp: 1,
	} as AgentMessage;
}

function toolResult(toolName: string, toolCallId: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	} as AgentMessage;
}

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function assistantText(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: 1,
		stopReason: "stop",
	} as AgentMessage;
}

function assistantThinking(thinking: string, text = "done"): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking },
			{ type: "text", text },
		],
		timestamp: 1,
		stopReason: "stop",
	} as AgentMessage;
}

function bigBlob(head: string, lines: number, tail: string): string {
	return `${head}\n${"line content here\n".repeat(lines)}${tail}`;
}

function readResult(toolCallId: string, text: string): AgentMessage {
	return toolResult("read", toolCallId, text);
}

function buildExploreHeavyScenario(): AgentMessage[] {
	const messages: AgentMessage[] = [];
	const paths = [
		"src/core/agent-session.ts",
		"src/core/compaction/compaction.ts",
		"src/core/tools/read.ts",
		"src/core/tools/grep.ts",
		"src/core/system-prompt.ts",
		"src/core/resource-loader.ts",
		"src/main.ts",
		"test/compaction.test.ts",
	];

	for (let round = 0; round < 2; round++) {
		for (let i = 0; i < paths.length; i++) {
			const id = `read-${round}-${i}`;
			messages.push(toolCall("read", id, { path: paths[i] }));
			messages.push(readResult(id, bigBlob(`READ_HEAD_${i}`, 600, `READ_TAIL_${i}`)));
		}
		for (let i = 0; i < 4; i++) {
			const id = `grep-${round}-${i}`;
			messages.push(toolCall("grep", id, { pattern: `pattern_${i}`, path: "src" }));
			messages.push(toolResult("grep", id, bigBlob(`GREP_HEAD_${i}`, 200, `GREP_TAIL_${i}`)));
		}
		messages.push(user(`explore round ${round + 1}`));
		messages.push(assistantText(`reviewed ${paths.length} files in round ${round + 1}`));
	}

	// Duplicate reads of the first four paths — supersede targets (old below size threshold).
	for (let i = 0; i < 4; i++) {
		const id = `read-dup-${i}`;
		messages.push(toolCall("read", id, { path: paths[i] }));
		messages.push(readResult(id, `fresh read of ${paths[i]}\n`.repeat(20)));
	}

	messages.push(user("final explore turn"));
	messages.push(assistantText("explore complete"));
	return messages;
}

function buildEditHeavyScenario(): AgentMessage[] {
	const messages: AgentMessage[] = [];
	const oldBody = "export function oldImpl() {\n" + "\treturn 1;\n".repeat(400) + "}\n";
	const newBody = "export function newImpl() {\n" + "\treturn 2;\n".repeat(400) + "}\n";

	// Early rounds: edits fall outside default protectTurns=2 (baseline for A3 arg elision).
	for (let round = 0; round < 4; round++) {
		for (let i = 0; i < 3; i++) {
			const idx = round * 3 + i;
			const id = `edit-early-${idx}`;
			messages.push(
				toolCall("edit", id, {
					path: `src/early/module-${idx}.ts`,
					oldText: oldBody,
					newText: newBody,
				}),
			);
			messages.push(toolResult("edit", id, `Edited src/early/module-${idx}.ts`));
		}
		messages.push(user(`early edit round ${round + 1}`));
		messages.push(assistantText(`early round ${round + 1} done`));
	}

	for (let i = 0; i < 6; i++) {
		const id = `edit-recent-${i}`;
		messages.push(
			toolCall("edit", id, {
				path: `src/recent/module-${i}.ts`,
				oldText: oldBody,
				newText: newBody,
			}),
		);
		messages.push(toolResult("edit", id, `Edited src/recent/module-${i}.ts`));
		if (i % 2 === 1) {
			messages.push(user(`recent checkpoint ${i + 1}`));
			messages.push(assistantText(`recent edit ${i + 1}`));
		}
	}

	messages.push(user("final edit turn"));
	messages.push(assistantText("edits complete"));
	return messages;
}

function buildLongReasoningScenario(): AgentMessage[] {
	const messages: AgentMessage[] = [];
	const thinkingBlock = "reasoning step\n".repeat(800);

	for (let i = 0; i < 5; i++) {
		messages.push(user(`problem ${i + 1}`));
		messages.push(assistantThinking(thinkingBlock, `answer ${i + 1}`));
		const id = `read-${i}`;
		messages.push(toolCall("read", id, { path: `src/file-${i}.ts` }));
		messages.push(readResult(id, bigBlob(`FILE_${i}`, 100, `END_${i}`)));
	}

	messages.push(user("final reasoning turn"));
	messages.push(assistantText("reasoning complete"));
	return messages;
}

function loadContextFiles(cwd: string): ContextFile[] {
	const out: ContextFile[] = [];
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const p = join(cwd, name);
		if (existsSync(p)) out.push({ path: p, content: readFileSync(p, "utf8") });
	}
	return out;
}

function loadSkills(): Skill[] {
	const skillsDir = join(homedir(), ".pit", "agent", "skills");
	if (!existsSync(skillsDir)) return [];
	const out: Skill[] = [];
	for (const entry of readdirSync(skillsDir)) {
		const skillFile = join(skillsDir, entry, "SKILL.md");
		if (!existsSync(skillFile)) continue;
		try {
			const raw = readFileSync(skillFile, "utf8");
			const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
			if (!fmMatch) continue;
			const fm = fmMatch[1];
			const nameMatch = fm.match(/^name:\s*(.+)$/m);
			const descMatch = fm.match(/^description:\s*(.+(?:\n[ \t]+.+)*)/m);
			if (!nameMatch || !descMatch) continue;
			const disableModelInvocation = /^disable-model-invocation:\s*true/m.test(fm);
			out.push({
				name: nameMatch[1].trim(),
				description: descMatch[1].replace(/\n[ \t]+/g, " ").trim(),
				filePath: skillFile,
				disableModelInvocation: disableModelInvocation || undefined,
			});
		} catch {}
	}
	return out;
}

type WirePrefixSurface = {
	systemPrompt: string;
	tools: WireToolSurface[];
	prefixTokens: number;
};

function measureWirePrefix(cwd: string): WirePrefixSurface {
	const toolsMap = createAllTools(cwd);
	const tools = Object.values(toolsMap);
	const toolSnippets: Record<string, string> = {};
	for (const t of tools) {
		toolSnippets[t.name] = (t as { promptSnippet?: string }).promptSnippet ?? t.description.split("\n")[0];
	}
	const guidelinesFromTools: string[] = [];
	for (const t of tools) {
		const pg = (t as { promptGuidelines?: string[] }).promptGuidelines;
		if (Array.isArray(pg)) guidelinesFromTools.push(...pg);
	}
	const systemPrompt = buildSystemPrompt({
		cwd,
		selectedTools: tools.map((t) => t.name),
		toolSnippets,
		promptGuidelines: guidelinesFromTools,
		contextFiles: loadContextFiles(cwd),
		skills: loadSkills(),
	});
	const wireTools: WireToolSurface[] = tools.map((t) => ({
		name: t.name,
		description: t.description,
		parameters: t.parameters,
	}));
	const wire = estimateWireTokens([], {
		systemPromptChars: systemPrompt.length,
		tools: wireTools,
	});
	return { systemPrompt, tools: wireTools, prefixTokens: wire.tokens };
}

function measureScenario(name: ScenarioName, wirePrefix: WirePrefixSurface): ScenarioMetrics {
	const builders: Record<ScenarioName, () => AgentMessage[]> = {
		"explore-heavy": buildExploreHeavyScenario,
		"edit-heavy": buildEditHeavyScenario,
		"long-reasoning": buildLongReasoningScenario,
	};
	const source = builders[name]();
	const messagesOnlyTokens = sumMessageTokens(source);
	const wireBeforePrune = estimateWireTokens(source, {
		systemPromptChars: wirePrefix.systemPrompt.length,
		tools: wirePrefix.tools,
	}).tokens;
	const floor = proactivePruneFloor(CONTEXT_WINDOW);

	const protectTurns = pressurePruneProtectTurns(messagesOnlyTokens, CONTEXT_WINDOW);

	const pruneCopy = cloneToolResultMessagesForPrune(source);
	const pruneThreshold = adaptivePruneThreshold(messagesOnlyTokens, CONTEXT_WINDOW);
	let pruneReclaimed = applyOldThinkingCap(pruneCopy, protectTurns);
	pruneReclaimed += pruneOldToolOutputs(pruneCopy, pruneThreshold, protectTurns, false);

	const supersedeCopy = cloneToolResultMessagesForPrune(source);
	let supersedeReclaimed = applyOldThinkingCap(supersedeCopy, protectTurns);
	supersedeReclaimed += applySupersedeOnly(supersedeCopy, PROTECT_TURNS);

	const liveCopy = cloneToolResultMessagesForPrune(source);
	let liveReclaimed = applyOldThinkingCap(liveCopy, protectTurns);
	liveReclaimed += applySupersedeOnly(liveCopy, PROTECT_TURNS);
	for (const msg of liveCopy) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block.type !== "toolCall") continue;
			liveReclaimed += elideMutatingToolCallArguments(liveCopy, block.id);
		}
	}

	const afterPruneWire = estimateWireTokens(pruneCopy, {
		systemPromptChars: wirePrefix.systemPrompt.length,
		tools: wirePrefix.tools,
	}).tokens;
	const afterSupersedeWire = estimateWireTokens(supersedeCopy, {
		systemPromptChars: wirePrefix.systemPrompt.length,
		tools: wirePrefix.tools,
	}).tokens;
	const afterLiveEconomyWire = estimateWireTokens(liveCopy, {
		systemPromptChars: wirePrefix.systemPrompt.length,
		tools: wirePrefix.tools,
	}).tokens;

	return {
		scenario: name,
		messagesOnlyTokens,
		prefixTokens: wirePrefix.prefixTokens,
		wireEstimateTokens: wireBeforePrune,
		afterPruneTokens: afterPruneWire,
		afterSupersedeTokens: afterSupersedeWire,
		afterLiveEconomyTokens: afterLiveEconomyWire,
		pruneReclaimedTokens: pruneReclaimed,
		supersedeReclaimedTokens: supersedeReclaimed,
		liveEconomyReclaimedTokens: liveReclaimed,
		proactivePruneFloorTokens: floor,
	};
}

function printScenarioMetrics(m: ScenarioMetrics): void {
	console.log(`\n=== ${m.scenario} ===`);
	console.log(`messages_only:        ${m.messagesOnlyTokens} toks`);
	console.log(`prefix_tokens:        ${m.prefixTokens} toks`);
	console.log(`wire_estimate:        ${m.wireEstimateTokens} toks (estimateWireTokens)`);
	console.log(`after_prune:          ${m.afterPruneTokens} toks (msg reclaimed ${m.pruneReclaimedTokens})`);
	console.log(`after_supersede:      ${m.afterSupersedeTokens} toks (reclaimed ${m.supersedeReclaimedTokens})`);
	console.log(`after_live_economy:   ${m.afterLiveEconomyTokens} toks (reclaimed ${m.liveEconomyReclaimedTokens})`);
	console.log(`proactive_prune_floor: ${m.proactivePruneFloorTokens} toks`);

	console.log(`METRIC scenario=${m.scenario} messages_only_tokens=${m.messagesOnlyTokens}`);
	console.log(`METRIC scenario=${m.scenario} prefix_tokens=${m.prefixTokens}`);
	console.log(`METRIC scenario=${m.scenario} wire_estimate_tokens=${m.wireEstimateTokens}`);
	console.log(`METRIC scenario=${m.scenario} after_prune_tokens=${m.afterPruneTokens}`);
	console.log(`METRIC scenario=${m.scenario} after_supersede_tokens=${m.afterSupersedeTokens}`);
	console.log(`METRIC scenario=${m.scenario} prune_reclaimed_tokens=${m.pruneReclaimedTokens}`);
	console.log(`METRIC scenario=${m.scenario} supersede_reclaimed_tokens=${m.supersedeReclaimedTokens}`);
	console.log(`METRIC scenario=${m.scenario} after_live_economy_tokens=${m.afterLiveEconomyTokens}`);
	console.log(`METRIC scenario=${m.scenario} live_economy_reclaimed_tokens=${m.liveEconomyReclaimedTokens}`);
}

const scenarioArg = parseScenarioArg(process.argv.slice(2));
const scenarios: ScenarioName[] =
	scenarioArg === "all" ? ["explore-heavy", "edit-heavy", "long-reasoning"] : [scenarioArg];

const wirePrefix = measureWirePrefix(process.cwd());
console.log(`bench-session-tokens (context_window=${CONTEXT_WINDOW})`);
console.log(`shared prefix_tokens: ${wirePrefix.prefixTokens}`);

for (const scenario of scenarios) {
	printScenarioMetrics(measureScenario(scenario, wirePrefix));
}

console.log(`\nMETRIC bench=session-tokens prefix_tokens=${wirePrefix.prefixTokens}`);
console.log(`METRIC bench=session-tokens scenarios=${scenarios.join(",")}`);