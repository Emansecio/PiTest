/**
 * Position requirements for project-aware language servers. Weak models default
 * to line 1 / first non-whitespace column without these guards — producing
 * silent wrong answers instead of actionable errors.
 */

import { isProjectAwareLspServer } from "./manager.ts";
import type { ServerConfig } from "./types.ts";

/** Single-file actions that need an explicit line + symbol on project-aware servers. */
export const LSP_PROJECT_AWARE_POSITION_ACTIONS = new Set([
	"definition",
	"type_definition",
	"implementation",
	"references",
	"hover",
	"rename",
	"code_actions",
]);

export function assertProjectAwarePosition(
	action: string,
	params: { line?: number; symbol?: string | undefined },
	serverConfig: ServerConfig,
): void {
	if (!isProjectAwareLspServer(serverConfig)) return;
	if (!LSP_PROJECT_AWARE_POSITION_ACTIONS.has(action)) return;

	if (params.line === undefined) {
		throw new Error(
			`line is required for project-aware ${action}; pass line=<1-based line number> together with symbol=<name>`,
		);
	}
	if (params.line < 1) {
		throw new Error(`line must be a 1-based line number (>= 1) for project-aware ${action}; got line=${params.line}`);
	}
	const symbol = params.symbol?.trim();
	if (!symbol) {
		throw new Error(
			`symbol is required for project-aware ${action}; pass symbol=<name> on that line, optionally symbol#N for repeated occurrences`,
		);
	}
}
