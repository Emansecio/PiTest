/**
 * Single source of truth for the grounding guard chain propagated to subagents.
 *
 * The chain is DATA: an explicit, named, ordered list. Registration order is
 * behavior (the first guard that blocks short-circuits the cascade), so it is
 * written out slot by slot rather than assembled by index arithmetic.
 *
 * Invariants encoded by the order below:
 *   - read-guard and edit-precondition come first: basic call-shape checks
 *     report before any per-arg grounding.
 *   - the parent-only guards (learned-error, intent-gate) take the
 *     {@link PARENT_INSERT_SLOT} slot — after edit-precondition, before the
 *     grounding chain proper. A "should you be editing yet" gate is coarser
 *     than per-arg symbol/path grounding and short-circuits the cascade when
 *     it fires.
 *   - erasable-syntax sits between import- and path-grounding.
 *
 * Parent-only guards are NOT part of this list: they are inserted by
 * {@link bundleGroundingGuardFactories}. Learned-error is registered on the
 * subagent chain in createSubagentGuardChain (same factory as the parent
 * insert). The destructive speed-bump is also registered separately in
 * createSubagentGuardChain (ADR-0006 middle tier) so the parent does not
 * double-register it.
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

/** Name of one slot in the grounding chain. */
export type GroundingGuardName =
	| "read-guard"
	| "edit-precondition"
	| "grounding-guard"
	| "import-grounding"
	| "erasable-syntax-precondition"
	| "path-grounding"
	| "pattern-grounding"
	| "bash-grounding";

/** Name given to each factory the parent bundle injects into {@link PARENT_INSERT_SLOT}. */
export const PARENT_INSERT_NAME = "parent-insert" as const;

/** The slot the parent bundle's extra guards are registered IMMEDIATELY BEFORE. */
export const PARENT_INSERT_SLOT: GroundingGuardName = "grounding-guard";

export interface GroundingGuardSlot {
	name: GroundingGuardName | typeof PARENT_INSERT_NAME;
	factory: ExtensionFactory;
}

/**
 * The subagent-propagated chain, in registration order. Every slot is named so
 * the order can be asserted by name (a swapped pair is a test failure, not a
 * silent behavior change).
 */
export function subagentGroundingGuardChain(cwd: string): GroundingGuardSlot[] {
	return [
		{ name: "read-guard", factory: createReadGuardExtension({ cwd }) },
		{ name: "edit-precondition", factory: createEditPreconditionExtension({ cwd }) },
		{ name: "grounding-guard", factory: createGroundingGuardExtension({ cwd }) },
		{ name: "import-grounding", factory: createImportGroundingExtension({ cwd }) },
		{ name: "erasable-syntax-precondition", factory: createErasableSyntaxPreconditionExtension({ cwd }) },
		{ name: "path-grounding", factory: createPathGroundingExtension({ cwd }) },
		{ name: "pattern-grounding", factory: createPatternGroundingExtension() },
		{ name: "bash-grounding", factory: createBashGroundingExtension({ cwd }) },
	];
}

/** Fixed order: basic guards before grounding guards (matches parent bundle). */
export function subagentGroundingGuardFactories(cwd: string): ExtensionFactory[] {
	return subagentGroundingGuardChain(cwd).map((slot) => slot.factory);
}

/**
 * Parent bundle chain: the subagent chain with `insertAfterEditPrecondition`
 * spliced into the {@link PARENT_INSERT_SLOT} slot (i.e. after edit-precondition,
 * before grounding-guard). Named, for order assertions.
 */
export function bundleGroundingGuardChain(
	cwd: string,
	insertAfterEditPrecondition: ExtensionFactory[] = [],
): GroundingGuardSlot[] {
	const out: GroundingGuardSlot[] = [];
	for (const slot of subagentGroundingGuardChain(cwd)) {
		if (slot.name === PARENT_INSERT_SLOT) {
			for (const factory of insertAfterEditPrecondition) out.push({ name: PARENT_INSERT_NAME, factory });
		}
		out.push(slot);
	}
	return out;
}

/**
 * Parent bundle order: read + edit, optional middle insert (learned-error,
 * intent-gate), then the remaining six grounding guards.
 */
export function bundleGroundingGuardFactories(
	cwd: string,
	insertAfterEditPrecondition: ExtensionFactory[] = [],
): ExtensionFactory[] {
	return bundleGroundingGuardChain(cwd, insertAfterEditPrecondition).map((slot) => slot.factory);
}

/** Register the subagent-propagated grounding chain on an ExtensionAPI shim. */
export function registerSubagentGroundingGuards(cwd: string, pi: ExtensionAPI): void {
	for (const factory of subagentGroundingGuardFactories(cwd)) {
		factory(pi);
	}
}
