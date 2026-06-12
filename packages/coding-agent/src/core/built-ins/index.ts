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
import { createCoordinatorExtension } from "./coordinator-extension.ts";
import { createEditPreconditionExtension } from "./edit-precondition-extension.ts";
import { createHooksExtension } from "./hooks-extension.ts";
import { createLearnedErrorGuardExtension } from "./learned-error-guard-extension.ts";
import { createMcpExtension } from "./mcp-extension.ts";
import { createMemoryExtension } from "./memory-extension.ts";
import { createPermissionsExtension } from "./permissions-extension.ts";
import { createReadGuardExtension } from "./read-guard-extension.ts";

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
		createReadGuardExtension({ cwd: options.cwd }),
		// Edit dry-run gate: re-uses computeEditsDiff to block an `edit` whose
		// oldText won't match BEFORE it enters the mutation queue, with a
		// copy-pasteable candidate hint. Runs after the read-guard so "not read"
		// is reported first. Opt out with PIT_NO_EDIT_PRECONDITION.
		createEditPreconditionExtension({ cwd: options.cwd }),
		// Preventive cross-session guard: blocks a call whose exact args have failed
		// repeatedly in prior sessions, before it fails again. Scoped to this
		// session's agent dir so isolated runs never read the shared store. No-op
		// when that store is empty or below threshold (fresh installs, tests).
		createLearnedErrorGuardExtension({ dir: learnedErrorsDirFor(options.agentDir) }),
		createHooksExtension({ settings: options.hooks, cwd: options.cwd }),
		createMemoryExtension({ cwd: options.cwd, agentDir: options.agentDir }),
		createMcpExtension({ settings: options.mcp }),
		createCoordinatorExtension({
			modelRegistry: options.modelRegistry,
			permissionChecker,
			getParentModel: options.getParentModel,
			getAvailableTools: options.getAvailableTools,
			getSkills: options.getSkills,
			isMessagingEnabled: options.isMessagingEnabled,
			getParentMessagingId: options.getParentMessagingId,
			getMessagingTimeoutMs: options.getMessagingTimeoutMs,
		}),
	];

	return { factories, permissionChecker };
}
