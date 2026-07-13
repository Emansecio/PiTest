/**
 * Built-in clarify-nudge extension (thin adapter).
 *
 * Per turn, when the prompt is mutating (task-rigor >= 2), looks
 * under-specified (see `../clarify-nudge.ts`), AND an interactive answer
 * surface is bound (UserInputBus has a listener — print/CI/subagents have
 * none, so asking would auto-resolve into noise), appends a `<clarify_first>`
 * directive telling the model it may ask up to 3 targeted questions via the
 * `ask` tool before its first mutating action. Nudge-only: never blocks a
 * call. Shares the turn-scoped rigor cache with task-rigor/intent-gate.
 * Fail-open; opt out with PIT_NO_CLARIFY_GATE.
 */

import { recordDiagnostic } from "@pit/ai";
import { assessPromptClarity, formatClarifyNudge, isClarifyNudgeDisabled } from "../clarify-nudge.ts";
import type { ExtensionAPI } from "../extensions/index.js";
import { classifyTaskRigor } from "../task-rigor.ts";
import { getCurrentUserInputBus } from "../user-input-bus.ts";

export function createClarifyNudgeExtension() {
	return (pi: ExtensionAPI) => {
		pi.on("before_agent_start", (event) => {
			try {
				if (isClarifyNudgeDisabled()) return undefined;
				// Interactive-only: without a bound picker the `ask` tool auto-answers,
				// so nudging the model to ask would only burn a round-trip.
				if (!getCurrentUserInputBus()?.hasListener()) return undefined;

				const rigor = classifyTaskRigor(event.prompt);
				if (rigor.rigor < 2) return undefined;

				const clarity = assessPromptClarity(event.prompt);
				if (!clarity.ambiguous) return undefined;

				recordDiagnostic({
					category: "quality.clarify",
					level: "info",
					source: "clarify-nudge-extension",
					context: {
						ruleId: "clarify-nudge",
						note: `signals=${clarity.signals.join(",")} rigor=${rigor.rigor}`,
					},
				});

				return { systemPrompt: `${event.systemPrompt}\n\n${formatClarifyNudge(clarity)}` };
			} catch {
				return undefined;
			}
		});
	};
}
