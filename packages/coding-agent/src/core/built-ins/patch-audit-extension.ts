/**
 * Built-in patch-audit extension.
 *
 * Post-exec, appends a compact self-review directive to medium/high-risk
 * write/edit results. It is intentionally model-agnostic: risk comes from the
 * patch shape, not from a model tier. Opt out with PIT_NO_PATCH_AUDIT.
 */

import { recordDiagnostic } from "@pit/ai";
import type { ExtensionAPI } from "../extensions/index.js";
import { auditPatchResult, isPatchAuditDisabled } from "../patch-audit.ts";

export function createPatchAuditExtension() {
	return (pi: ExtensionAPI) => {
		pi.on("tool_result", (event) => {
			try {
				if (isPatchAuditDisabled()) return undefined;

				const decision = auditPatchResult({
					toolName: event.toolName,
					input: event.input,
					details: event.details,
					isError: event.isError,
				});
				if (decision.action === "skip") return undefined;

				recordDiagnostic({
					category: "guard.patch-audit",
					level: decision.audit.risk === "high" ? "warn" : "info",
					source: "patch-audit-extension",
					context: {
						path: decision.audit.path,
						note: `${decision.audit.toolName} ${decision.audit.risk} ${decision.audit.changedLines} changed lines`,
					},
				});

				return {
					content: [...event.content, { type: "text" as const, text: decision.message }],
				};
			} catch {
				return undefined;
			}
		});
	};
}
