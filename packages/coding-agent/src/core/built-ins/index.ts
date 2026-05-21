/**
 * Built-in extensions shipped with pi-coding-agent.
 *
 * The application layer composes the factories returned here into the
 * `extensionFactories` option passed to the resource loader. Each factory is
 * a no-op when its configuration is absent (e.g. zero MCP servers, empty
 * hooks settings) so the only cost of bundling them is a function-pointer
 * lookup at startup.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "../extensions/types.ts";
import type { HooksSettings } from "../hooks/index.ts";
import type { McpSettings } from "../mcp/index.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { PermissionChecker, type PermissionMode, type PermissionSettings } from "../permissions/index.ts";
import { createCoordinatorExtension } from "./coordinator-extension.ts";
import { createDiffLimitExtension } from "./diff-limit-extension.ts";
import { createHooksExtension } from "./hooks-extension.ts";
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
	/** Audit hook for permission decisions (telemetry / logs). */
	onPermissionDecision?: (info: { toolName: string; decision: "allow" | "ask" | "deny"; reason?: string }) => void;
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
	const effectiveMode: PermissionMode = options.permissionModeOverride ?? options.permissions.mode ?? "default";
	const permissionChecker = new PermissionChecker({
		cwd: options.cwd,
		mode: effectiveMode,
		settings: options.permissions,
	});

	const factories: ExtensionFactory[] = [
		createPermissionsExtension({ checker: permissionChecker, onDecision: options.onPermissionDecision }),
		createReadGuardExtension({ cwd: options.cwd }),
		createDiffLimitExtension(),
		createHooksExtension({ settings: options.hooks, cwd: options.cwd }),
		createMemoryExtension({ cwd: options.cwd, agentDir: options.agentDir }),
		createMcpExtension({ settings: options.mcp }),
		createCoordinatorExtension({
			modelRegistry: options.modelRegistry,
			getParentModel: options.getParentModel,
			getAvailableTools: options.getAvailableTools,
		}),
	];

	return { factories, permissionChecker };
}
