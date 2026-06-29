/**
 * Live context economy applied to session messages after tool success (D2, A3).
 */

import type { AgentMessage, AgentToolCall } from "@pit/agent-core";
import { recordDiagnostic } from "@pit/ai";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import { isMutatingToolCall } from "./agent-session-tool-end.ts";
import {
	applySupersedeOnly,
	cloneToolResultMessagesForPrune,
	elideMutatingToolCallArguments,
	estimateContextTokens,
	planContextPrune,
	pressurePruneProtectTurns,
	wouldApplySupersedeOnly,
} from "./compaction/compaction.ts";

import { isLspSupersedeEligible } from "./lsp/supersede.ts";

const SUPERSEDED_TOOL_NAMES = new Set(["read", "grep", "find", "ls", "symbol", "find_symbol", "lsp"]);

export interface LiveContextEconomyResult {
	messages: AgentMessage[];
	reclaimed: number;
	supersedeReclaimed: number;
	argElisionReclaimed: number;
}

export function applyLiveContextEconomyAfterToolSuccess(
	messages: AgentMessage[],
	toolCall: AgentToolCall,
	isError: boolean,
	contextWindow: number,
): LiveContextEconomyResult {
	if (isError) {
		return { messages, reclaimed: 0, supersedeReclaimed: 0, argElisionReclaimed: 0 };
	}

	const contextTokens = estimateContextTokens(messages).tokens;
	const protectTurns = pressurePruneProtectTurns(contextTokens, contextWindow);
	const prunePlan = planContextPrune(messages, protectTurns);
	const runSupersede =
		!isTruthyEnvFlag(process.env.PIT_NO_LIVE_SUPERSEDE) &&
		SUPERSEDED_TOOL_NAMES.has(toolCall.name) &&
		(toolCall.name !== "lsp" || isLspSupersedeEligible(toolCall.arguments)) &&
		wouldApplySupersedeOnly(messages, protectTurns, prunePlan);
	const runArgElision =
		!isTruthyEnvFlag(process.env.PIT_NO_LIVE_ARG_ELISION) && isMutatingToolCall(toolCall.name, toolCall.arguments);

	if (!runSupersede && !runArgElision) {
		return { messages, reclaimed: 0, supersedeReclaimed: 0, argElisionReclaimed: 0 };
	}

	const copy = cloneToolResultMessagesForPrune(messages);
	let supersedeReclaimed = 0;
	let argElisionReclaimed = 0;

	if (runSupersede) {
		supersedeReclaimed = applySupersedeOnly(copy, protectTurns, prunePlan);
	}
	if (runArgElision) {
		argElisionReclaimed = elideMutatingToolCallArguments(copy, toolCall.id);
	}

	const reclaimed = supersedeReclaimed + argElisionReclaimed;
	if (reclaimed > 0) {
		recordDiagnostic({
			category: "prune.live",
			level: "info",
			source: "agent-session.applyLiveContextEconomyAfterToolSuccess",
			context: {
				bytes: reclaimed,
				note: `tool=${toolCall.name} supersede=${supersedeReclaimed} args=${argElisionReclaimed}`,
			},
		});
	}

	return {
		messages: reclaimed > 0 ? copy : messages,
		reclaimed,
		supersedeReclaimed,
		argElisionReclaimed,
	};
}
