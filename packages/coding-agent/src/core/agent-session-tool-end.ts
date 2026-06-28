/**
 * Tool-execution-end helpers extracted from AgentSession for clarity.
 * Pure/state-mutating functions only — steering and discovery stay in the session.
 */

import { extname } from "node:path";
import type { ToolErrorHintRegistry } from "@pit/agent-core";
import { recordDiagnostic } from "@pit/ai";
import { extractToolFileOp } from "./compaction/utils.ts";
import type { LearnedErrorEntry } from "./learned-error-store.ts";
import { normalizeErrorFingerprint, truncateErrorSample } from "./learned-error-store.ts";
import { MUTATING_TOOL_NAMES } from "./stagnation.ts";
import { fingerprintToolArgs } from "./tool-call-stats.ts";
import { createSameSessionHintRule } from "./tool-error-hint-rules.ts";
import { classifyBashCommand } from "./tools/bash-activity.ts";

export const SAME_SESSION_HINT_THRESHOLD = 2;
export const MAX_LEARNED_ERRORS = 500;

const VISUAL_FILE_EXTENSIONS = new Set([
	".html",
	".htm",
	".svg",
	".tsx",
	".jsx",
	".vue",
	".svelte",
	".css",
	".scss",
	".sass",
	".less",
]);

export interface VerificationGateState {
	turnTouchedFiles: boolean;
	turnTouchedFilePaths: Set<string>;
	turnTouchedVisual: boolean;
	lastVisualFile?: string;
	turnFixSite?: { file: string; line: number };
}

export interface ArmVerificationGateOptions {
	/** When false, only sets turnTouchedFiles (code-mode lite path). Default true. */
	trackPaths?: boolean;
	result?: { details?: { firstChangedLine?: number } };
}

export function isMutatingToolCall(toolName: string, args: unknown): boolean {
	if (MUTATING_TOOL_NAMES.has(toolName)) return true;
	if (toolName === "bash" && typeof args === "object" && args !== null) {
		const command = (args as { command?: unknown }).command;
		if (typeof command === "string" && command.length > 0) {
			return classifyBashCommand(command) === "action";
		}
	}
	return false;
}

export function armVerificationGate(
	state: VerificationGateState,
	toolName: string,
	args: unknown,
	options?: ArmVerificationGateOptions,
): void {
	const trackPaths = options?.trackPaths !== false;
	const fileOp = extractToolFileOp(toolName, args);
	if (fileOp) {
		if (fileOp.op !== "read") {
			state.turnTouchedFiles = true;
			if (trackPaths) {
				state.turnTouchedFilePaths.add(fileOp.path);
				const firstChangedLine = options?.result?.details?.firstChangedLine;
				if (typeof firstChangedLine === "number" && firstChangedLine >= 1) {
					state.turnFixSite = { file: fileOp.path, line: firstChangedLine };
				}
				if (VISUAL_FILE_EXTENSIONS.has(extname(fileOp.path).toLowerCase())) {
					state.turnTouchedVisual = true;
					state.lastVisualFile = fileOp.path;
				}
			}
		}
		return;
	}
	if (isMutatingToolCall(toolName, args)) {
		state.turnTouchedFiles = true;
	}
}

export interface LearnedErrorUpsertState {
	learnedErrors: Map<string, LearnedErrorEntry>;
	sameSessionHintKeys: Set<string>;
	toolErrorHintRegistry: ToolErrorHintRegistry | undefined;
}

export interface LearnedErrorUpsertResult {
	fingerprint?: string;
	dirty: boolean;
}

/** Upsert a failure fingerprint into the session learned-error map. */
export function upsertLearnedErrorOnFailure(params: {
	toolName: string;
	args: unknown;
	rawError: string;
	matchedHintRules?: string[];
	state: LearnedErrorUpsertState;
}): LearnedErrorUpsertResult {
	const fingerprint = normalizeErrorFingerprint(params.rawError);
	if (!fingerprint) return { dirty: false };

	const key = `${params.toolName}:${fingerprint}`;
	const existing = params.state.learnedErrors.get(key);
	if (existing) {
		params.state.learnedErrors.delete(key);
		params.state.learnedErrors.set(key, existing);
		existing.count += 1;
		if (params.matchedHintRules && params.matchedHintRules.length > 0 && !existing.matchedRuleId) {
			existing.matchedRuleId = params.matchedHintRules[0];
		}
		if (
			existing.count >= SAME_SESSION_HINT_THRESHOLD &&
			!existing.matchedRuleId &&
			!params.state.sameSessionHintKeys.has(key)
		) {
			params.state.sameSessionHintKeys.add(key);
			params.state.toolErrorHintRegistry?.add(
				createSameSessionHintRule({
					tool: existing.tool,
					fingerprint: existing.fingerprint,
					count: existing.count,
					index: params.state.sameSessionHintKeys.size,
				}),
			);
		}
		return { fingerprint, dirty: true };
	}

	if (params.state.learnedErrors.size >= MAX_LEARNED_ERRORS) {
		const oldestKey = params.state.learnedErrors.keys().next().value;
		if (oldestKey !== undefined) {
			params.state.learnedErrors.delete(oldestKey);
			recordDiagnostic({
				category: "limit.evicted",
				level: "info",
				source: "agent-session.learnedErrors",
				context: { note: "learned-errors cap" },
			});
		}
	}
	params.state.learnedErrors.set(key, {
		tool: params.toolName,
		fingerprint,
		count: 1,
		matchedRuleId: params.matchedHintRules?.[0],
		sampleErrorText: truncateErrorSample(params.rawError),
		sampleArgs: params.args !== undefined ? fingerprintToolArgs(params.args, 160) : undefined,
	});
	return { fingerprint, dirty: true };
}
