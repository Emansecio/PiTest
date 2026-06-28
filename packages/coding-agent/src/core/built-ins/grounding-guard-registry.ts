/**
 * Single source of truth for the grounding guard chain propagated to subagents.
 *
 * Parent-only guards (learned-error, destructive-command, patch-audit, etc.)
 * are inserted by bundleBuiltInExtensions between edit-precondition and
 * grounding-guard, or after bash-grounding — not part of this list.
 */

import type { ExtensionAPI } from "../extensions/index.js";
import type { ExtensionFactory } from "../extensions/types.ts";
import { createBashGroundingExtension } from "./bash-grounding-extension.ts";
import { createEditPreconditionExtension } from "./edit-precondition-extension.ts";
import { createErasableSyntaxPreconditionExtension } from "./erasable-syntax-precondition-extension.ts";
import { createGroundingGuardExtension } from "./grounding-guard-extension.ts";
import { createImportGroundingExtension } from "./import-grounding-extension.ts";
import { createPathGroundingExtension } from "./path-grounding-extension.ts";
import { createPatternGroundingExtension } from "./pattern-grounding-extension.ts";
import { createReadGuardExtension } from "./read-guard-extension.ts";

/** Fixed order: basic guards before grounding guards (matches parent bundle). */
export function subagentGroundingGuardFactories(cwd: string): ExtensionFactory[] {
	return [
		createReadGuardExtension({ cwd }),
		createEditPreconditionExtension({ cwd }),
		createGroundingGuardExtension({ cwd }),
		createImportGroundingExtension({ cwd }),
		createErasableSyntaxPreconditionExtension({ cwd }),
		createPathGroundingExtension({ cwd }),
		createPatternGroundingExtension(),
		createBashGroundingExtension({ cwd }),
	];
}

/**
 * Parent bundle order: read + edit, optional middle insert (learned-error),
 * then the remaining six grounding guards.
 */
export function bundleGroundingGuardFactories(
	cwd: string,
	insertAfterEditPrecondition: ExtensionFactory[] = [],
): ExtensionFactory[] {
	const chain = subagentGroundingGuardFactories(cwd);
	return [chain[0], chain[1], ...insertAfterEditPrecondition, ...chain.slice(2)];
}

/** Register the subagent-propagated grounding chain on an ExtensionAPI shim. */
export function registerSubagentGroundingGuards(cwd: string, pi: ExtensionAPI): void {
	for (const factory of subagentGroundingGuardFactories(cwd)) {
		factory(pi);
	}
}
