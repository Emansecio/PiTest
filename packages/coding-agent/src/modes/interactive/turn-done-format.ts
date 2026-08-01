import type { AgentMessage } from "@pit/agent-core";
import type { AssistantMessage } from "@pit/ai";
import { formatCost, formatElapsed, formatTokens } from "../../utils/format-display.ts";

export interface TurnDoneSnapshot {
	elapsedMs: number;
	inputTokens: number;
	outputTokens: number;
	cost?: number;
	stopReason: "stop" | "aborted" | "error" | "toolUse";
}

export function buildTurnDoneSnapshot(messages: AgentMessage[], elapsedMs: number): TurnDoneSnapshot {
	let inputTokens = 0;
	let outputTokens = 0;
	let cost = 0;
	let stopReason: TurnDoneSnapshot["stopReason"] = "stop";

	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		if (assistant.stopReason) {
			const reason = assistant.stopReason;
			if (reason === "aborted" || reason === "error" || reason === "toolUse" || reason === "stop") {
				stopReason = reason;
			} else {
				stopReason = "stop";
			}
		}
		const usage = assistant.usage;
		if (!usage) continue;
		inputTokens += usage.input ?? 0;
		outputTokens += usage.output ?? 0;
		cost += usage.cost?.total ?? 0;
	}

	return {
		elapsedMs,
		inputTokens,
		outputTokens,
		cost: cost > 0 ? cost : undefined,
		stopReason,
	};
}

export function formatTurnDoneDisplayLine(snapshot: TurnDoneSnapshot): string {
	if (snapshot.stopReason === "aborted") {
		return `${formatElapsed(snapshot.elapsedMs)} · aborted`;
	}
	if (snapshot.stopReason === "error") {
		return `${formatElapsed(snapshot.elapsedMs)} · error`;
	}

	const parts: string[] = [formatElapsed(snapshot.elapsedMs)];
	const io: string[] = [];
	if (snapshot.inputTokens > 0) io.push(`↑${formatTokens(snapshot.inputTokens)}`);
	if (snapshot.outputTokens > 0) io.push(`↓${formatTokens(snapshot.outputTokens)}`);
	if (io.length > 0) parts.push(io.join(" "));
	if (snapshot.cost !== undefined && snapshot.cost > 0) {
		parts.push(formatCost(snapshot.cost));
	}
	return parts.join(" · ");
}

export function shouldRenderTurnDone(snapshot: TurnDoneSnapshot): boolean {
	return snapshot.stopReason === "aborted" || snapshot.stopReason === "error";
}
