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
import { createCoordinatorExtension } from "./coordinator-extension.ts";
import { createDestructiveCommandGuardExtension } from "./destructive-command-guard-extension.ts";
import { bundleGroundingGuardFactories } from "./grounding-guard-registry.ts";
import { createHooksExtension } from "./hooks-extension.ts";
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
	/** Returns the parent's loaded skills — used by the coordinator for `inherit_skills`. */
	getSkills?: () => import("../skills.ts").Skill[];
	/** Audit hook for permission decisions (telemetry / logs). */
	onPermissionDecision?: (info: { toolName: string; decision: "allow" | "deny"; reason?: string }) => void;
	isMessagingEnabled?: () => boolean;
	getParentMessagingId?: () => string | undefined;
	getMessagingTimeoutMs?: () => number | undefined;
	/** Forwarded to the coordinator extension: fires when an async (op:"spawn") subagent settles. Returns true if re-injected. */
	onAsyncComplete?: (handle: string, text: string, status: "done" | "error") => boolean;
	/** Forwarded to the coordinator: fires once when a subagent (run or spawn) starts. */
	onSubagentStart?: (handle: string) => void;
	/** Forwarded to the coordinator: fires once per finished subagent turn (live progress). */
	onSubagentProgress?: (handle: string, info: { turn: number; lastTool?: string }) => void;
	/** Forwarded to the coordinator: true when subagent memory should be scoped by agent type. */
	isScopedHindsightEnabled?: () => boolean;
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
		createPermissionsExtension({ checker: permissionChecker, onDecision: options.onPermissionDecision }),
		// Task rigor: before each turn, classify task risk from the prompt and
		// append concise rigor instructions. Model-agnostic, fail-open; opt out
		// PIT_NO_TASK_RIGOR.
		createTaskRigorExtension(),
		...bundleGroundingGuardFactories(options.cwd, [
			// Preventive cross-session guard: blocks a call whose exact args have failed
			// repeatedly in prior sessions, before it fails again. Scoped to this
			// session's agent dir so isolated runs never read the shared store. No-op
			// when that store is empty or below threshold (fresh installs, tests).
			createLearnedErrorGuardExtension({ dir: learnedErrorsDirFor(options.agentDir) }),
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
		createHooksExtension({ settings: options.hooks, cwd: options.cwd }),
		createMemoryExtension({ cwd: options.cwd, agentDir: options.agentDir }),
		createMcpExtension({ settings: options.mcp, cwd: options.cwd, agentDir: options.agentDir }),
		createCoordinatorExtension({
			modelRegistry: options.modelRegistry,
			permissionChecker,
			getParentModel: options.getParentModel,
			getAvailableTools: options.getAvailableTools,
			getSkills: options.getSkills,
			isMessagingEnabled: options.isMessagingEnabled,
			getParentMessagingId: options.getParentMessagingId,
			getMessagingTimeoutMs: options.getMessagingTimeoutMs,
			onAsyncComplete: options.onAsyncComplete,
			onSubagentStart: options.onSubagentStart,
			onSubagentProgress: options.onSubagentProgress,
			isScopedHindsightEnabled: options.isScopedHindsightEnabled,
			getTokenGovernor: () => getCurrentTokenGovernor(),
		}),
	];

	return { factories, permissionChecker };
}
