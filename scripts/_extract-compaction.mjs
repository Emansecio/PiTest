import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync("packages/coding-agent/src/core/agent-session.ts", "utf8");
const lines = src.split("\n");

function extract(start, end) {
	return lines.slice(start - 1, end).join("\n");
}

const maybePrune = extract(3011, 3044)
	.replace(/^	private /gm, "")
	.replace(/_maybePruneStaleToolOutputs/g, "maybePruneStaleToolOutputs")
	.replace(/this\./g, "slice.");

const pipeline = extract(4027, 4127)
	.replace(/^	private async /gm, "export async function ")
	.replace(/_executeCompactionPipeline/g, "executeCompactionPipeline");

const compactFn = extract(4134, 4193)
	.replace(/^	async /gm, "export async function ")
	.replace(/\bcompact\b/g, "compactSession");

const checkFn = extract(4746, 4898)
	.replace(/^	private async /gm, "export async function ")
	.replace(/_checkCompaction/g, "checkCompaction")
	.replace(/_runAutoCompaction/g, "runAutoCompaction")
	.replace(/_awaitBackgroundCompaction/g, "awaitBackgroundCompaction")
	.replace(/_maybePruneStaleToolOutputs/g, "maybePruneStaleToolOutputs")
	.replace(/this\./g, "slice.");

const awaitBg = extract(4905, 4914)
	.replace(/^	private async /gm, "export async function ")
	.replace(/_awaitBackgroundCompaction/g, "awaitBackgroundCompaction")
	.replace(/this\./g, "slice.");

const runAuto = extract(4921, 5028)
	.replace(/^	private async /gm, "export async function ")
	.replace(/_executeCompactionPipeline/g, "executeCompactionPipeline")
	.replace(/this\./g, "slice.");

const header = `/**
 * Compaction pipeline extracted from AgentSession (move-only).
 */

import type { Agent, ThinkingLevel } from "@pit/agent-core";
import type { AssistantMessage, Model } from "@pit/ai";
import { isContextOverflow, recordDiagnostic, streamSimple } from "@pit/ai";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import {
	adaptivePruneThreshold,
	cloneToolResultMessagesForPrune,
	pressurePruneProtectTurns,
	pruneOldToolOutputs,
	wouldPruneOldToolOutputs,
} from "./compaction/compaction.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	compact,
	computeDynamicReserve,
	estimateContextTokens,
	prepareCompaction,
	proactivePruneFloor,
	shouldCompact,
	shouldCompactSoft,
} from "./compaction/index.ts";
import type { ExtensionRunner } from "./extensions/index.js";
import type { HindsightBank } from "./hindsight/index.js";
import type { CompactionEntry, SessionEntry, SessionManager } from "./session-manager.js";
import { getLatestCompactionEntry } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import type { ReadDedupeStore } from "./tools/read.js";
import { formatNoModelSelectedMessage } from "./auth-guidance.ts";
import type { AgentSessionEvent } from "./agent-session.ts";
import type { SessionBeforeCompactResult } from "./extensions/index.js";

const PRESEND_OVERFLOW_RATIO = 0.95;

export interface CompactionSessionSlice {
	sessionId: string;
	model: Model<any> | undefined;
	thinkingLevel: ThinkingLevel;
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	extensionRunner: ExtensionRunner;
	hindsightBank: HindsightBank | undefined;
	readDedupeStore: ReadDedupeStore | undefined;
	cwd: string;
	isCompacting: boolean;
	isStreaming: boolean;
	getOverflowRecoveryAttempted(): boolean;
	setOverflowRecoveryAttempted(value: boolean): void;
	getLastCompactionDeficit(): number;
	setLastCompactionDeficit(value: number): void;
	getBackgroundCompactionPromise(): Promise<unknown> | undefined;
	setBackgroundCompactionPromise(value: Promise<unknown> | undefined): void;
	getCompactionAbortController(): AbortController | undefined;
	setCompactionAbortController(value: AbortController | undefined): void;
	getAutoCompactionAbortController(): AbortController | undefined;
	setAutoCompactionAbortController(value: AbortController | undefined): void;
	emit(event: AgentSessionEvent): void;
	getCompactionRequestAuth(model: Model<any>): Promise<{ apiKey?: string; headers?: Record<string, string> }>;
	disconnectFromAgent(): void;
	reconnectToAgent(): void;
	abort(): Promise<void>;
}

`;

let body = [maybePrune, pipeline, compactFn, checkFn, awaitBg, runAuto].join("\n\n");
body = body.replace(/this\./g, "slice.");
body = body.replace(/slice\._executeCompactionPipeline/g, "executeCompactionPipeline(slice,");
body = body.replace(/executeCompactionPipeline\(slice,\(/g, "executeCompactionPipeline(slice, ");
body = body.replace(/slice\._runAutoCompaction/g, "runAutoCompaction(slice,");
body = body.replace(/runAutoCompaction\(slice,\(/g, "runAutoCompaction(slice, ");
body = body.replace(/slice\._awaitBackgroundCompaction/g, "awaitBackgroundCompaction(slice");
body = body.replace(/slice\._maybePruneStaleToolOutputs/g, "maybePruneStaleToolOutputs(slice,");
body = body.replace(/maybePruneStaleToolOutputs\(slice,\(/g, "maybePruneStaleToolOutputs(slice, ");
body = body.replace(/slice\._getCompactionRequestAuth/g, "slice.getCompactionRequestAuth");
body = body.replace(/slice\._disconnectFromAgent/g, "slice.disconnectFromAgent");
body = body.replace(/slice\._reconnectToAgent/g, "slice.reconnectToAgent");
body = body.replace(/slice\._emit/g, "slice.emit");
body = body.replace(/slice\._readDedupeStore/g, "slice.readDedupeStore");
body = body.replace(/slice\._hindsightBank/g, "slice.hindsightBank");
body = body.replace(/slice\._extensionRunner/g, "slice.extensionRunner");
body = body.replace(/slice\._cwd/g, "slice.cwd");
body = body.replace(/slice\._overflowRecoveryAttempted/g, "slice.getOverflowRecoveryAttempted()");
body = body.replace(/slice\._lastCompactionDeficit/g, "slice.getLastCompactionDeficit()");
body = body.replace(/slice\._backgroundCompactionPromise/g, "slice.getBackgroundCompactionPromise()");
body = body.replace(/slice\._compactionAbortController/g, "slice.getCompactionAbortController()");
body = body.replace(/slice\._autoCompactionAbortController/g, "slice.getAutoCompactionAbortController()");

// Fix assignments to mutable state
body = body.replace(/slice\.getOverflowRecoveryAttempted\(\) = true/g, "slice.setOverflowRecoveryAttempted(true)");
body = body.replace(/slice\.getLastCompactionDeficit\(\) = /g, "slice.setLastCompactionDeficit(");
// This is wrong for assignments - need manual fix

writeFileSync("packages/coding-agent/src/core/agent-session-compaction.ts", header + body);
console.log("wrote agent-session-compaction.ts", (header + body).split("\n").length, "lines");