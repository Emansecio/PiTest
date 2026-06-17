import { join } from "node:path";
import type { ThinkingLevel } from "@pit/agent-core";
import type { Model } from "@pit/ai";
import { getAgentDir } from "../config.ts";
import { AuthStorage } from "./auth-storage.ts";
import { bundleBuiltInExtensions } from "./built-ins/index.ts";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { composeMcpSettings, loadMcpConfigFiles } from "./mcp/config-files.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { PermissionMode } from "./permissions/index.ts";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions, type ResourceLoader } from "./resource-loader.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./sdk.ts";
import type { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";

/**
 * Non-fatal issues collected while creating services or sessions.
 *
 * Runtime creation returns diagnostics to the caller instead of printing or
 * exiting. The app layer decides whether warnings should be shown and whether
 * errors should abort startup.
 */
export interface AgentSessionRuntimeDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

/**
 * Inputs for creating cwd-bound runtime services.
 *
 * These services are recreated whenever the effective session cwd changes.
 * CLI-provided resource paths should be resolved to absolute paths before they
 * reach this function, so later cwd switches do not reinterpret them.
 */
export interface CreateAgentSessionServicesOptions {
	cwd: string;
	agentDir?: string;
	authStorage?: AuthStorage;
	settingsManager?: SettingsManager;
	modelRegistry?: ModelRegistry;
	extensionFlagValues?: Map<string, boolean | string>;
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	/** Override permission mode for this session (CLI --permission-mode). */
	permissionModeOverride?: PermissionMode;
	/** Disable bundling of built-in extensions (permissions/hooks/mcp/memory/coordinator). */
	disableBuiltInExtensions?: boolean;
}

/**
 * Inputs for creating an AgentSession from already-created services.
 *
 * Use this after services exist and any cwd-bound model/tool/session options
 * have been resolved against those services.
 */
export interface CreateAgentSessionFromServicesOptions {
	services: AgentSessionServices;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
	noTools?: CreateAgentSessionOptions["noTools"];
	customTools?: ToolDefinition[];
	disableHashlineAnchors?: boolean;
}

/**
 * Coherent cwd-bound runtime services for one effective session cwd.
 *
 * This is infrastructure only. The AgentSession itself is created separately so
 * session options can be resolved against these services first.
 */
export interface AgentSessionServices {
	cwd: string;
	agentDir: string;
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	resourceLoader: ResourceLoader;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) {
		return [];
	}

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	return diagnostics;
}

/**
 * Create cwd-bound runtime services.
 *
 * Returns services plus diagnostics. It does not create an AgentSession.
 */
import { time } from "./timings.js";

export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const cwd = options.cwd;
	const agentDir = options.agentDir ?? getAgentDir();
	time("services-init-start");
	const authStorage = options.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
	time("services-init-authStorage");
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	time("services-init-settingsManager");
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	time("services-init-modelRegistry");

	// Refs filled in after the AgentSession is created. The coordinator extension
	// reads through these to keep its tool catalog in sync with the parent's
	// active tools without re-loading. Model and tools are GETTERS, not captured
	// values: `/model` swaps `agent.state.model` and `setActiveToolsByName`
	// reassigns `agent.state.tools` (a fresh array), so a snapshot taken at
	// construction goes stale and subagents would spawn with the boot-time
	// model/catalog.
	const parentModelRef: { current?: () => import("@pit/ai").Model<any> | undefined } = {};
	const availableToolsRef: { current?: () => import("@pit/agent-core").AgentTool[] } = {};
	const parentMessagingIdRef: { current?: string } = {};
	const asyncDeliverRef: { current?: (handle: string, text: string, status: "done" | "error") => boolean } = {};

	let builtInFactories: import("./extensions/types.ts").ExtensionFactory[] = [];
	if (!options.disableBuiltInExtensions) {
		const bundle = bundleBuiltInExtensions({
			cwd,
			agentDir,
			modelRegistry,
			permissions: settingsManager.getPermissionSettings(),
			permissionModeOverride: options.permissionModeOverride,
			hooks: settingsManager.getHooksSettings(),
			mcp: composeMcpSettings(settingsManager.getMcpSettingsLayered(), loadMcpConfigFiles(cwd, agentDir)),
			getParentModel: () => parentModelRef.current?.(),
			getAvailableTools: () => availableToolsRef.current?.() ?? [],
			// Resolved lazily at subagent-spawn time, well after resourceLoader init.
			getSkills: () => resourceLoader.getSkills().skills,
			isMessagingEnabled: () => settingsManager.getAgentMessagingSettings().enabled,
			getParentMessagingId: () => parentMessagingIdRef.current,
			getMessagingTimeoutMs: () => settingsManager.getAgentMessagingSettings().timeoutMs,
			onAsyncComplete: (handle, text, status) => asyncDeliverRef.current?.(handle, text, status) ?? false,
		});
		builtInFactories = bundle.factories;
	}

	const userFactories = options.resourceLoaderOptions?.extensionFactories ?? [];
	const resourceLoaderOptions: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager"> = {
		...(options.resourceLoaderOptions ?? {}),
		extensionFactories: [...builtInFactories, ...userFactories],
	};

	const resourceLoader = new DefaultResourceLoader({
		...resourceLoaderOptions,
		cwd,
		agentDir,
		settingsManager,
	});
	time("services-init-resourceLoader-create");
	await resourceLoader.reload();
	time("services-init-resourceLoader-reload");

	// Wire up refs once the session is created. The session-services layer does
	// not know about AgentSession directly, so we expose helpers via the
	// returned services object that the caller (createAgentSessionFromServices)
	// flushes after Session construction.
	(
		resourceLoader as DefaultResourceLoader & {
			__bindBuiltInRefs?: (
				getModel: () => import("@pit/ai").Model<any> | undefined,
				getTools: () => import("@pit/agent-core").AgentTool[],
				messagingId: string | undefined,
				deliverAsync: (handle: string, text: string, status: "done" | "error") => boolean,
			) => void;
		}
	).__bindBuiltInRefs = (getModel, getTools, messagingId, deliverAsync) => {
		parentModelRef.current = getModel;
		availableToolsRef.current = getTools;
		parentMessagingIdRef.current = messagingId;
		asyncDeliverRef.current = deliverAsync;
	};

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			modelRegistry.registerProvider(name, config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

	return {
		cwd,
		agentDir,
		authStorage,
		settingsManager,
		modelRegistry,
		resourceLoader,
		diagnostics,
	};
}

/**
 * Create an AgentSession from previously created services.
 *
 * This keeps session creation separate from service creation so callers can
 * resolve model, thinking, tools, and other session inputs against the target
 * cwd before constructing the session.
 */
export async function createAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	// Build the TTSR matcher from settings here so the session/loop wiring stays
	// declarative. Off by default — only allocated when at least one rule is
	// configured. Bad regex patterns surface as warnings, not crashes, so a
	// typo in settings.json cannot brick the session.
	let ttsrMatcher: import("@pit/agent-core").TTSRMatcher | undefined;
	try {
		const rawRules = options.services.settingsManager.getTTSRRules();
		if (rawRules.length > 0) {
			const ttsrModule = await import("./ttsr.ts");
			const compiled = ttsrModule.compileRules(rawRules);
			if (compiled.length > 0) {
				ttsrMatcher = ttsrModule.createMatcher(compiled);
			}
		}
	} catch (error) {
		options.services.diagnostics.push({
			type: "warning",
			message: `TTSR: ${error instanceof Error ? error.message : String(error)}`,
		});
	}

	const result = await createAgentSession({
		cwd: options.services.cwd,
		agentDir: options.services.agentDir,
		authStorage: options.services.authStorage,
		settingsManager: options.services.settingsManager,
		modelRegistry: options.services.modelRegistry,
		resourceLoader: options.services.resourceLoader,
		sessionManager: options.sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		scopedModels: options.scopedModels,
		tools: options.tools,
		noTools: options.noTools,
		customTools: options.customTools,
		sessionStartEvent: options.sessionStartEvent,
		disableHashlineAnchors: options.disableHashlineAnchors,
		ttsrMatcher,
	});

	const bind = (
		options.services.resourceLoader as DefaultResourceLoader & {
			__bindBuiltInRefs?: (
				getModel: () => import("@pit/ai").Model<any> | undefined,
				getTools: () => import("@pit/agent-core").AgentTool[],
				messagingId: string | undefined,
				deliverAsync: (handle: string, text: string, status: "done" | "error") => boolean,
			) => void;
		}
	).__bindBuiltInRefs;
	if (bind) {
		bind(
			() => result.session.model,
			() => result.session.agent.state.tools as import("@pit/agent-core").AgentTool[],
			result.session.messagingId,
			(handle, text, status) => result.session._deliverAsyncResult(handle, text, status),
		);
	}

	return result;
}
