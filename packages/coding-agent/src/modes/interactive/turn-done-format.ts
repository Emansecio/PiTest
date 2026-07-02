import type { AgentMessage } from "@pit/agent-core";
import type { AssistantMessage } from "@pit/ai";
import { formatElapsed } from "../../core/goal/goal-manager.ts";

export interface TurnDoneSnapshot {
	elapsedMs: number;
	inputTokens: number;
	outputTokens: number;
	cost?: number;
	stopReason: "stop" | "aborted" | "error" | "toolUse";
	contextPercent?: number;
	estimated?: boolean;
}

function formatCompactTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function buildTurnDoneSnapshot(
	messages: AgentMessage[],
	elapsedMs: number,
	contextUsage?: { percent?: number | null; estimated?: boolean },
): TurnDoneSnapshot {
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
		contextPercent: contextUsage?.percent ?? undefined,
		estimated: contextUsage?.estimated,
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
	if (snapshot.inputTokens > 0) io.push(`↑${formatCompactTokens(snapshot.inputTokens)}`);
	if (snapshot.outputTokens > 0) io.push(`↓${formatCompactTokens(snapshot.outputTokens)}`);
	if (io.length > 0) parts.push(io.join(" "));
	if (snapshot.cost !== undefined && snapshot.cost > 0) {
		const costText = snapshot.cost < 0.01 ? `$${snapshot.cost.toFixed(4)}` : `$${snapshot.cost.toFixed(2)}`;
		parts.push(costText);
	}
	if (snapshot.contextPercent !== undefined) {
		const rounded = Math.round(snapshot.contextPercent);
		const prefix = snapshot.estimated ? "~" : "";
		parts.push(`ctx ${prefix}${rounded}%`);
	}
	return parts.join(" · ");
}
