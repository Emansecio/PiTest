/**
 * Built-in extensions shipped with pi-coding-agent.
 *
 * The application layer composes the factories returned here into the
 * `extensionFactories` option passed to the resource loader. Each factory is
 * a no-op when its configuration is absent (e.g. zero MCP servers, empty
 * hooks settings) so the only cost of bundling them is a function-pointer
 * lookup at startup.
 */

import type { AgentTool } from "@pit/agent-core";
import type { Model } from "@pit/ai";
import type { ExtensionFactory } from "../extensions/types.ts";
import type { HooksSettings } from "../hooks/index.ts";
import { learnedErrorsDirFor } from "../learned-error-store.ts";
import type { McpSettings } from "../mcp/index.ts";
import type { ModelRegistry } from "../model-registry.ts";
import {
	normalizePermissionMode,
	PermissionChecker,
	type PermissionMode,
	type PermissionSettings,
} from "../permissions/index.ts";
import { getCurrentTokenGovernor } from "../token-governor.ts";
import type { ReadDedupeStore } from "../tools/read.ts";
import type { WarmFileCache } from "../tools/warm-file-cache.ts";
import { createClarifyNudgeExtension } from "./clarify-nudge-extension.ts";
import { createCoordinatorExtension } from "./coordinator-extension.ts";
import { createDestructiveCommandGuardExtension } from "./destructive-command-guard-extension.ts";
import { createExternalEditSentinelExtension } from "./external-edit-sentinel-extension.ts";
import { createGraphPrefetchExtension } from "./graph-prefetch-extension.ts";
import { bundleGroundingGuardFactories } from "./grounding-guard-registry.ts";
import { createHooksExtension } from "./hooks-extension.ts";
import { createImpactExtension } from "./impact-extension.ts";
import { createIntentGateExtension } from "./intent-gate-extension.ts";
import { createLearnedErrorGuardExtension } from "./learned-error-guard-extension.ts";
import { createMcpExtension } from "./mcp-extension.ts";
import { createMemoryExtension } from "./memory-extension.ts";
import { createPatchAuditExtension } from "./patch-audit-extension.ts";
import { createPermissionsExtension } from "./permissions-extension.ts";
import { createTaskRigorExtension } from "./task-rigor-extension.ts";

export { createCoordinatorExtension } from "./coordinator-extension.ts";
export { createHooksExtension } from "./hooks-extension.ts";
export { createMcpExtension } from "./mcp-extension.ts";
export { createMemoryExtension } from "./memory-extension.ts";
export { createPermissionsExtension, DEFAULT_PERMISSION_SETTINGS } from "./permissions-extension.ts";

export interface BuiltInExtensionsOptions {
	cwd: string;
	agentDir: string;
	modelRegistry: ModelRegistry;
	permissions: PermissionSettings;
	permissionModeOverride?: PermissionMode;
	hooks: HooksSettings;
	mcp: McpSettings;
	/** Returns the parent's active model — used by the coordinator. */
	getParentModel: () => Model<any> | undefined;
	/** Returns the parent's tool catalog — used by the coordinator. */
	getAvailableTools: () => AgentTool[];
	/** Rebuilds cwd-sensitive tools with the session's configured options for worktree children. */
	retargetToolsForCwd?: (tools: AgentTool[], cwd: string) => AgentTool[];
	/** Returns the parent's loaded skills — used by the coordinator for `inherit_skills`. */
	getSkills?: () => import("../skills.ts").Skill[];
	/** Audit hook for permission decisions (telemetry / logs). */
	onPermissionDecision?: (info: { toolName: string; decision: "allow" | "deny"; reason?: string }) => void;
	/** Fired after the permission mode changes (slash command, cycle key, or exit_plan approval). */
	onPermissionModeChange?: (mode: PermissionMode) => void;
	/** True when Fusion panel has ≥2 advisors. Gates Alt+P into Fusion. */
	isFusionPanelReady?: () => boolean;
	/** Open `/fusion` when the user cycles into Fusion without a configured panel. */
	onFusionNeedsSetup?: () => void;
	isMessagingEnabled?: () => boolean;
	getParentMessagingId?: () => string | undefined;
	getMessagingTimeoutMs?: () => number | undefined;
	/** Forwarded to the coordinator extension: fires when an async (op:"spawn") subagent settles. Returns true if re-injected. */
	onAsyncComplete?: (
		handle: string,
		text: string,
		status: "done" | "error",
		meta?: { turns?: number; totalTokens?: number },
	) => boolean;
	/** Forwarded to the coordinator: fires once when a subagent (run or spawn) starts. */
	onSubagentStart?: (handle: string) => void;
	/** Forwarded to the coordinator: fires once per finished subagent turn (live progress). */
	onSubagentProgress?: (handle: string, info: { turn: number; lastTool?: string }) => void;
	/** Forwarded to the coordinator: fires when a blocking run/resume/continue settles. */
	onSubagentComplete?: (
		handle: string,
		status: "done" | "error",
		meta?: { turns?: number; totalTokens?: number },
	) => void;
	/** Called once with a function that aborts all detached spawns (wired to session.interrupt). */
	registerAbortDetached?: (abortFn: () => void) => void;
	/** Forwarded to the coordinator: true when subagent memory should be scoped by agent type. */
	isScopedHindsightEnabled?: () => boolean;
	/**
	 * Accessor for the session's read-dedupe store — used by the external-edit
	 * sentinel to invalidate dedupe entries for files that changed outside the
	 * session. Resolved lazily (the session doesn't exist yet when extensions are
	 * bundled); undefined in contexts that never construct one (tests, dedupe
	 * disabled via PIT_READ_DEDUPE=0).
	 */
	getReadDedupeStore?: () => ReadDedupeStore | undefined;
	/**
	 * Accessor for the session's graph-prefetch warm cache — used by the
	 * graph-prefetch extension to warm neighbors of a just-read file. Resolved
	 * lazily (the session doesn't exist yet when extensions are bundled);
	 * undefined in contexts that never construct one (tests, prefetch disabled
	 * via `PIT_NO_GRAPH_PREFETCH`).
	 */
	getWarmFileCache?: () => WarmFileCache | undefined;
}

export interface BuiltInExtensionsResult {
	factories: ExtensionFactory[];
	permissionChecker: PermissionChecker;
}

/**
 * Assemble the array of built-in extension factories with the supplied config.
 * Returns the shared PermissionChecker so the host can mutate the mode at
 * runtime via /permission-mode without re-loading.
 */
export function bundleBuiltInExtensions(options: BuiltInExtensionsOptions): BuiltInExtensionsResult {
	const effectiveMode: PermissionMode =
		options.permissionModeOverride ?? normalizePermissionMode(options.permissions.mode) ?? "auto";
	const permissionChecker = new PermissionChecker({
		cwd: options.cwd,
		mode: effectiveMode,
		settings: options.permissions,
	});

	const factories: ExtensionFactory[] = [
		createPermissionsExtension({
			cwd: options.cwd,
			checker: permissionChecker,
			onDecision: options.onPermissionDecision,
			onModeChange: options.onPermissionModeChange,
			isFusionPanelReady: options.isFusionPanelReady,
			onFusionNeedsSetup: options.onFusionNeedsSetup,
		}),
		// Task rigor: before each turn, classify task risk from the prompt and
		// append concise rigor instructions. Model-agnostic, fail-open; opt out
		// PIT_NO_TASK_RIGOR.
		createTaskRigorExtension(),
		// Clarify nudge: when a mutating prompt looks under-specified AND an
		// interactive answer surface is bound, append a `<clarify_first>` directive
		// so the model asks up to 3 targeted questions via `ask` before its first
		// mutation instead of guessing. Parent-only, nudge-only, fail-open; opt out
		// PIT_NO_CLARIFY_GATE.
		createClarifyNudgeExtension(),
		...bundleGroundingGuardFactories(options.cwd, [
			// Preventive cross-session guard: blocks a call whose exact args have failed
			// repeatedly in prior sessions, before it fails again. Scoped to this
			// session's agent dir so isolated runs never read the shared store. No-op
			// when that store is empty or below threshold (fresh installs, tests).
			createLearnedErrorGuardExtension({ dir: learnedErrorsDirFor(options.agentDir) }),
			// Intent gate (Band P / P2): on a risky prompt (thermostat level × task
			// rigor), require a plan validated against the real tree before the first
			// mutating call. Placed in the insertAfterEditPrecondition slot — AFTER
			// read-guard / edit-precondition / learned-error (basic call-shape checks
			// report first) and BEFORE the grounding chain (a "should you be editing
			// yet" gate is coarser than per-arg symbol/path grounding, and short-circuits
			// the cascade when it fires). Parent-only: it reads the session-global plan
			// and thermostat registries, so it is never propagated to subagents.
			// Fail-open; opt out PIT_NO_INTENT_GATE.
			createIntentGateExtension({ cwd: options.cwd }),
		]),
		// Destructive-command guard: pre-exec, fire-once speed-bump for the MIDDLE tier
		// of destruction the permission deny-floor (catastrophic `/`/`~` only) lets run
		// under auto mode — `rm -rf ./src`, `git reset --hard`, `git clean -fd`,
		// `git checkout .`, `git push --force`. Block-once with an impact note;
		// re-issue confirms and runs. Fail-open; opt out PIT_NO_DESTRUCTIVE_GUARD.
		createDestructiveCommandGuardExtension(),
		// Patch audit: post-exec, appends a compact self-review directive to
		// medium/high-risk write/edit results based on patch shape. Model-agnostic,
		// fail-open; opt out PIT_NO_PATCH_AUDIT.
		createPatchAuditExtension(),
		// Impact graph (code-graph Fase 2): post-exec, appends a compact "N files
		// depend on this" advisory to successful edit/write results using the
		// Fase 1 import graph (repo-map/graph.ts blastRadius), and tracks
		// unreviewed direct dependents for the goal_complete R10 gate. Degrades to
		// a no-op automatically when the map has no deps (PIT_NO_REPO_GRAPH).
		// Model-agnostic, fail-open; opt out PIT_NO_IMPACT_GUARD.
		createImpactExtension({ cwd: options.cwd }),
		// External-edit sentinel: registers a (mtime,size) baseline for every
		// file the session touches, then sweeps it once per turn (before_agent_start)
		// so a change made outside the session (editor, formatter, another agent)
		// surfaces proactively instead of only at the moment a stale edit is
		// attempted. Also invalidates the read-dedupe entry for changed files so
		// the next read is sent in full. Fail-open; opt out PIT_NO_EXTERNAL_EDIT_SENTINEL.
		createExternalEditSentinelExtension({ cwd: options.cwd, getReadDedupeStore: options.getReadDedupeStore }),
		// Graph prefetch (code-graph P6): post-exec, warms the on-disk content of
		// a just-read/symbol/find_symbol file's grade-1 graph neighbors into an
		// in-memory cache (`ReadToolOptions.warmFileCache`) that `read.ts`
		// consults before its own disk read. Zero tokens — nothing here ever
		// reaches the model; a warm entry only shortcuts I/O, gated on the live
		// file stat matching exactly. Fail-open; opt out PIT_NO_GRAPH_PREFETCH.
		createGraphPrefetchExtension({ cwd: options.cwd, getWarmFileCache: options.getWarmFileCache }),
		createHooksExtension({ settings: options.hooks, cwd: options.cwd }),
		createMemoryExtension({ cwd: options.cwd, agentDir: options.agentDir }),
		createMcpExtension({ settings: options.mcp, cwd: options.cwd, agentDir: options.agentDir }),
		createCoordinatorExtension({
			modelRegistry: options.modelRegistry,
			permissionChecker,
			getParentModel: options.getParentModel,
			getAvailableTools: options.getAvailableTools,
			retargetToolsForCwd: options.retargetToolsForCwd,
			getSkills: options.getSkills,
			isMessagingEnabled: options.isMessagingEnabled,
			getParentMessagingId: options.getParentMessagingId,
			getMessagingTimeoutMs: options.getMessagingTimeoutMs,
			onAsyncComplete: options.onAsyncComplete,
			onSubagentStart: options.onSubagentStart,
			onSubagentProgress: options.onSubagentProgress,
			onSubagentComplete: options.onSubagentComplete,
			registerAbortDetached: options.registerAbortDetached,
			isScopedHindsightEnabled: options.isScopedHindsightEnabled,
			getTokenGovernor: () => getCurrentTokenGovernor(),
		}),
	];

	return { factories, permissionChecker };
}
