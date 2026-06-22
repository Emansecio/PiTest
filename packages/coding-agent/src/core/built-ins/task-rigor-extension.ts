/**
 * Built-in task-rigor extension.
 *
 * Per turn, classifies task risk from the user prompt and appends a compact
 * rigor directive to the system prompt. This is model-agnostic: it changes the
 * harness behavior for risky work without labeling model capability.
 * Opt out with PIT_NO_TASK_RIGOR.
 */

import { recordDiagnostic } from "@pit/ai";
import type { ExtensionAPI } from "../extensions/index.js";
import { appendTaskRigorPrompt, classifyTaskRigor, isTaskRigorDisabled } from "../task-rigor.ts";

export function createTaskRigorExtension() {
	return (pi: ExtensionAPI) => {
		pi.on("before_agent_start", (event) => {
			try {
				if (isTaskRigorDisabled()) return undefined;
				const rigor = classifyTaskRigor(event.prompt);
				if (rigor.rigor === 0) return undefined;

				recordDiagnostic({
					category: "quality.rigor",
					level: "info",
					source: "task-rigor-extension",
					context: {
						note: `rigor=${rigor.rigor} risk=${rigor.risk} reasons=${rigor.reasons.join(",")}`,
					},
				});

				return { systemPrompt: appendTaskRigorPrompt(event.systemPrompt, rigor) };
			} catch {
				return undefined;
			}
		});
	};
}
