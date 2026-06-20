import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import chalk from "chalk";
import { CONFIG_DIR_NAME } from "../config.js";
import { loadThemeFromPath, type Theme } from "../modes/interactive/theme/theme.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import { time } from "./timings.js";

export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.ts";

import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import { canonicalizePath, isLocalPath, isUnderPath } from "../utils/paths.ts";
import { createEventBus, type EventBus } from "./event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } from "./extensions/loader.ts";
import type { Extension, ExtensionFactory, ExtensionRuntime, LoadExtensionsResult } from "./extensions/types.ts";
import { discoverLegacyResources, type LegacyDiscoveryResult } from "./legacy-discovery.ts";
import { discoverMemoryFiles, type MemoryFile } from "./memory/index.ts";
import { DefaultPackageManager, type PathMetadata } from "./package-manager.ts";
import { loadProjectConfigContext } from "./project-config-context.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { loadPromptTemplates } from "./prompt-templates.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import { getClaudeCodeSkillsDir, loadSkills } from "./skills.ts";
import { createSourceInfo, type SourceInfo } from "./source-info.ts";

/**
 * Pre-resolved, insertion-ordered view of a source-path -> value map.
 *
 * `findSourceInfoForPath` is called once per skill/prompt/theme/extension on
 * every reload and previously re-resolve()-d every entry of `metadataByPath`
 * (and `extraSourceInfos`) in a linear scan — O(N resources * M entries) with
 * a resolve() syscall-ish cost per comparison. We precompute the normalized
 * source paths once per map instance and cache the result keyed by the map's
 * identity (the maps are rebuilt fresh each reload, so the WeakMap entries are
 * collected automatically). The prefix `find` preserves the original semantics:
 * the first entry in insertion order whose normalized path is an exact or
 * `${path}${sep}`-prefix match wins.
 */
interface SourceLookup<V> {
	entries: Array<{ normalized: string; value: V }>;
	find(normalizedResourcePath: string): V | undefined;
}

// Cache keyed by map identity AND size. These maps (metadataByPath /
// extraSourceInfos) are populated append-only and can grow BETWEEN
// findSourceInfoForPath calls within a single reload (e.g. extendResources),
// so a plain identity cache would serve a stale (under-populated) lookup and
// miss later-added entries. size is an exact freshness signal for append-only
// maps; in the hot loop (N skills over a fully-populated map) size is stable
// so the lookup is still built once and reused N-1 times.
const sourceLookupCache = new WeakMap<Map<string, unknown>, { size: number; lookup: SourceLookup<unknown> }>();

function buildSourceLookup<V>(map: Map<string, V>): SourceLookup<V> {
	const entries: Array<{ normalized: string; value: V }> = [];
	for (const [sourcePath, value] of map.entries()) {
		entries.push({ normalized: resolve(sourcePath), value });
	}
	return {
		entries,
		find(normalizedResourcePath: string): V | undefined {
			for (const { normalized, value } of entries) {
				if (normalizedResourcePath === normalized || normalizedResourcePath.startsWith(`${normalized}${sep}`)) {
					return value;
				}
			}
			return undefined;
		},
	};
}

function getSourceLookup<V>(map: Map<string, V>): SourceLookup<V> {
	const cached = sourceLookupCache.get(map as Map<string, unknown>);
	if (cached && cached.size === map.size) {
		return cached.lookup as SourceLookup<V>;
	}
	const lookup = buildSourceLookup(map);
	sourceLookupCache.set(map as Map<string, unknown>, { size: map.size, lookup: lookup as SourceLookup<unknown> });
	return lookup;
}

export interface ResourceExtensionPaths {
	skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
	promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
	themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}

export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getSkillByName(name: string): Skill | undefined;
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getMemoryFiles(): MemoryFile[];
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
	extendResources(paths: ResourceExtensionPaths): void;
	reload(): Promise<void>;
}

function resolvePromptInput(input: string | undefined, description: string): string | undefined {
	if (!input) {
		return undefined;
	}

	if (existsSync(input)) {
		try {
			return readFileSync(input, "utf-8");
		} catch (error) {
			console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
			return input;
		}
	}

	return input;
}

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				return {
					path: filePath,
					content: readFileSync(filePath, "utf-8"),
				};
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return null;
}

export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
	noLegacyDiscovery?: boolean;
	legacyResult?: LegacyDiscoveryResult;
}): Array<{ path: string; content: string }> {
	const resolvedCwd = options.cwd;
	const resolvedAgentDir = options.agentDir;

	const contextFiles: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();

	const globalContext = loadContextFileFromDir(resolvedAgentDir);
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: Array<{ path: string; content: string }> = [];

	let currentDir = resolvedCwd;
	const root = resolve("/");

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}

		if (currentDir === root) break;

		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);

	if (!options.noLegacyDiscovery) {
		const legacy =
			options.legacyResult ??
			discoverLegacyResources({
				cwd: resolvedCwd,
				agentDir: resolvedAgentDir,
				seenPaths,
			});
		for (const rule of legacy.ruleFiles) {
			contextFiles.push({ path: rule.path, content: rule.content });
		}
	}

	// Distill the project's own tsconfig/biome conventions into the context so
	// the model generates conformant code on the first attempt even when no
	// AGENTS.md documents them. Best-effort: null when nothing parseable.
	const configContext = loadProjectConfigContext(resolvedCwd);
	if (configContext) {
		contextFiles.push(configContext);
	}

	return contextFiles;
}

export interface DefaultResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	settingsManager?: SettingsManager;
	eventBus?: EventBus;
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	extensionFactories?: ExtensionFactory[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	noLegacyDiscovery?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

export class DefaultResourceLoader implements ResourceLoader {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private eventBus: EventBus;
	private packageManager: DefaultPackageManager;
	private additionalExtensionPaths: string[];
	private additionalSkillPaths: string[];
	private additionalPromptTemplatePaths: string[];
	private additionalThemePaths: string[];
	private extensionFactories: ExtensionFactory[];
	private noExtensions: boolean;
	private noSkills: boolean;
	private noPromptTemplates: boolean;
	private noThemes: boolean;
	private noContextFiles: boolean;
	private noLegacyDiscovery: boolean;
	private systemPromptSource?: string;
	private appendSystemPromptSource?: string[];
	private extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	private skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	private promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	private themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	private agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	private systemPromptOverride?: (base: string | undefined) => string | undefined;
	private appendSystemPromptOverride?: (base: string[]) => string[];

	private extensionsResult: LoadExtensionsResult;
	private skills: Skill[];
	private skillDiagnostics: ResourceDiagnostic[];
	private prompts: PromptTemplate[];
	private promptDiagnostics: ResourceDiagnostic[];
	private themes: Theme[];
	private themeDiagnostics: ResourceDiagnostic[];
	private agentsFiles: Array<{ path: string; content: string }>;
	private memoryFiles: MemoryFile[];
	private systemPrompt?: string;
	private appendSystemPrompt: string[];
	private skillsByName: Map<string, Skill>;
	private lastSkillPaths: string[];
	private extensionSkillSourceInfos: Map<string, SourceInfo>;
	private extensionPromptSourceInfos: Map<string, SourceInfo>;
	private extensionThemeSourceInfos: Map<string, SourceInfo>;
	private lastPromptPaths: string[];
	private lastThemePaths: string[];

	constructor(options: DefaultResourceLoaderOptions) {
		this.cwd = options.cwd;
		this.agentDir = options.agentDir;
		this.settingsManager = options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
		this.eventBus = options.eventBus ?? createEventBus();
		this.packageManager = new DefaultPackageManager({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
		});
		this.additionalExtensionPaths = options.additionalExtensionPaths ?? [];
		this.additionalSkillPaths = options.additionalSkillPaths ?? [];
		this.additionalPromptTemplatePaths = options.additionalPromptTemplatePaths ?? [];
		this.additionalThemePaths = options.additionalThemePaths ?? [];
		this.extensionFactories = options.extensionFactories ?? [];
		this.noExtensions = options.noExtensions ?? false;
		this.noSkills = options.noSkills ?? false;
		this.noPromptTemplates = options.noPromptTemplates ?? false;
		this.noThemes = options.noThemes ?? false;
		this.noContextFiles = options.noContextFiles ?? false;
		this.noLegacyDiscovery = options.noLegacyDiscovery ?? false;
		this.systemPromptSource = options.systemPrompt;
		this.appendSystemPromptSource = options.appendSystemPrompt;
		this.extensionsOverride = options.extensionsOverride;
		this.skillsOverride = options.skillsOverride;
		this.promptsOverride = options.promptsOverride;
		this.themesOverride = options.themesOverride;
		this.agentsFilesOverride = options.agentsFilesOverride;
		this.systemPromptOverride = options.systemPromptOverride;
		this.appendSystemPromptOverride = options.appendSystemPromptOverride;

		this.extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
		this.skills = [];
		this.skillDiagnostics = [];
		this.prompts = [];
		this.promptDiagnostics = [];
		this.themes = [];
		this.themeDiagnostics = [];
		this.agentsFiles = [];
		this.memoryFiles = [];
		this.appendSystemPrompt = [];
		this.skillsByName = new Map();
		this.lastSkillPaths = [];
		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();
		this.lastPromptPaths = [];
		this.lastThemePaths = [];
	}

	getExtensions(): LoadExtensionsResult {
		return this.extensionsResult;
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: this.skills, diagnostics: this.skillDiagnostics };
	}

	getSkillByName(name: string): Skill | undefined {
		return this.skillsByName.get(name);
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
	}

	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		return { themes: this.themes, diagnostics: this.themeDiagnostics };
	}

	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		return { agentsFiles: this.agentsFiles };
	}

	getMemoryFiles(): MemoryFile[] {
		return this.memoryFiles;
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getAppendSystemPrompt(): string[] {
		return this.appendSystemPrompt;
	}

	extendResources(paths: ResourceExtensionPaths): void {
		const skillPaths = this.normalizeExtensionPaths(paths.skillPaths ?? []);
		const promptPaths = this.normalizeExtensionPaths(paths.promptPaths ?? []);
		const themePaths = this.normalizeExtensionPaths(paths.themePaths ?? []);

		for (const entry of skillPaths) {
			this.extensionSkillSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		for (const entry of promptPaths) {
			this.extensionPromptSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		for (const entry of themePaths) {
			this.extensionThemeSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}

		if (skillPaths.length > 0) {
			this.lastSkillPaths = this.mergePaths(
				this.lastSkillPaths,
				skillPaths.map((entry) => entry.path),
			);
			this.updateSkillsFromPaths(this.lastSkillPaths);
		}

		if (promptPaths.length > 0) {
			this.lastPromptPaths = this.mergePaths(
				this.lastPromptPaths,
				promptPaths.map((entry) => entry.path),
			);
			this.updatePromptsFromPaths(this.lastPromptPaths);
		}

		if (themePaths.length > 0) {
			this.lastThemePaths = this.mergePaths(
				this.lastThemePaths,
				themePaths.map((entry) => entry.path),
			);
			this.updateThemesFromPaths(this.lastThemePaths);
		}
	}

	async reload(): Promise<void> {
		time("reload-start");
		await this.settingsManager.reload();
		time("reload-settings-reload");
		const [resolvedPaths, cliExtensionPaths] = await Promise.all([
			this.packageManager.resolve(),
			this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {
				temporary: true,
			}),
		]);
		time("reload-package-resolve");
		const metadataByPath = new Map<string, PathMetadata>();

		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();

		// Helper to extract enabled paths and store metadata
		const getEnabledResources = (
			resources: Array<{ path: string; enabled: boolean; metadata: PathMetadata }>,
		): Array<{ path: string; enabled: boolean; metadata: PathMetadata }> => {
			for (const r of resources) {
				if (!metadataByPath.has(r.path)) {
					metadataByPath.set(r.path, r.metadata);
				}
			}
			return resources.filter((r) => r.enabled);
		};

		const getEnabledPaths = (
			resources: Array<{ path: string; enabled: boolean; metadata: PathMetadata }>,
		): string[] => getEnabledResources(resources).map((r) => r.path);
		const enabledExtensions = getEnabledPaths(resolvedPaths.extensions);
		const enabledSkillResources = getEnabledResources(resolvedPaths.skills);
		const enabledPrompts = getEnabledPaths(resolvedPaths.prompts);
		const enabledThemes = getEnabledPaths(resolvedPaths.themes);

		const mapSkillPath = async (resource: { path: string; metadata: PathMetadata }): Promise<string> => {
			if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") {
				return resource.path;
			}
			try {
				const stats = await stat(resource.path);
				if (!stats.isDirectory()) {
					return resource.path;
				}
			} catch {
				return resource.path;
			}
			const skillFile = join(resource.path, "SKILL.md");
			try {
				await access(skillFile);
			} catch {
				return resource.path;
			}
			if (!metadataByPath.has(skillFile)) {
				metadataByPath.set(skillFile, resource.metadata);
			}
			return skillFile;
		};

		// Resolve skill paths concurrently; reload() is async, so the previously
		// synchronous stat/exists per skill no longer blocks the event loop.
		const enabledSkills = await Promise.all(enabledSkillResources.map(mapSkillPath));

		// Add CLI paths metadata
		for (const r of cliExtensionPaths.extensions) {
			if (!metadataByPath.has(r.path)) {
				metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
			}
		}
		for (const r of cliExtensionPaths.skills) {
			if (!metadataByPath.has(r.path)) {
				metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
			}
		}

		const cliEnabledExtensions = getEnabledPaths(cliExtensionPaths.extensions);
		const cliEnabledSkills = getEnabledPaths(cliExtensionPaths.skills);
		const cliEnabledPrompts = getEnabledPaths(cliExtensionPaths.prompts);
		const cliEnabledThemes = getEnabledPaths(cliExtensionPaths.themes);

		const extensionPaths = this.noExtensions
			? cliEnabledExtensions
			: this.mergePaths(cliEnabledExtensions, enabledExtensions);

		const extensionsResult = await loadExtensions(extensionPaths, this.cwd, this.eventBus);
		const inlineExtensions = await this.loadExtensionFactories(extensionsResult.runtime);
		extensionsResult.extensions.push(...inlineExtensions.extensions);
		extensionsResult.errors.push(...inlineExtensions.errors);
		time("reload-load-extensions");

		// Detect extension conflicts (tools, commands, flags with same names from different extensions)
		// Keep all extensions loaded. Conflicts are reported as diagnostics, and precedence is handled by load order.
		const conflicts = this.detectExtensionConflicts(extensionsResult.extensions);
		for (const conflict of conflicts) {
			extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
		}

		for (const p of this.additionalExtensionPaths) {
			if (isLocalPath(p) && !existsSync(p)) {
				extensionsResult.errors.push({ path: p, error: `Extension path does not exist: ${p}` });
			}
		}
		this.extensionsResult = this.extensionsOverride ? this.extensionsOverride(extensionsResult) : extensionsResult;
		this.applyExtensionSourceInfo(this.extensionsResult.extensions, metadataByPath);

		const legacyResult: LegacyDiscoveryResult =
			this.noLegacyDiscovery || (this.noContextFiles && this.noSkills)
				? { ruleFiles: [], skillDirs: [] }
				: discoverLegacyResources({ cwd: this.cwd, agentDir: this.agentDir });
		time("reload-legacy-discovery");

		// PIT_NO_LEGACY_SKILLS opts out of legacy skill *directories* only
		// (.claude/.cursor/.codex/.gemini skills/), leaving legacy rule files
		// intact. Default-on: unset = identical behavior. The global
		// --no-legacy-discovery still wins (already yields an empty skillDirs).
		const legacySkillPaths =
			this.noLegacyDiscovery || isTruthyEnvFlag(process.env.PIT_NO_LEGACY_SKILLS) ? [] : legacyResult.skillDirs;
		const skillPaths = this.noSkills
			? this.mergePaths(cliEnabledSkills, [...this.additionalSkillPaths, ...legacySkillPaths])
			: this.mergePaths(
					[...cliEnabledSkills, ...enabledSkills],
					[...this.additionalSkillPaths, ...legacySkillPaths],
				);

		// Claude Code skills (~/.claude/skills) as a tertiary source. The reload
		// path always calls loadSkills with includeDefaults:false (it supplies
		// every directory explicitly), so the default-source block inside
		// loadSkills never runs in production — without this, that whole skill
		// class is silently invisible. Appended LAST so agent + project +
		// explicit skills win on name collisions (first-loaded wins). Suppressed
		// by --no-skills; getClaudeCodeSkillsDir() itself applies the
		// PIT_DISABLE_CLAUDE_CODE_SKILLS opt-out (returns null).
		if (!this.noSkills) {
			const claudeSkillsDir = getClaudeCodeSkillsDir();
			if (claudeSkillsDir && existsSync(claudeSkillsDir) && !skillPaths.includes(claudeSkillsDir)) {
				skillPaths.push(claudeSkillsDir);
			}
		}

		this.lastSkillPaths = skillPaths;
		this.updateSkillsFromPaths(skillPaths, metadataByPath);
		time("reload-update-skills");
		for (const p of this.additionalSkillPaths) {
			if (isLocalPath(p) && !existsSync(p) && !this.skillDiagnostics.some((d) => d.path === p)) {
				this.skillDiagnostics.push({ type: "error", message: "Skill path does not exist", path: p });
			}
		}

		const promptPaths = this.noPromptTemplates
			? this.mergePaths(cliEnabledPrompts, this.additionalPromptTemplatePaths)
			: this.mergePaths([...cliEnabledPrompts, ...enabledPrompts], this.additionalPromptTemplatePaths);

		this.lastPromptPaths = promptPaths;
		this.updatePromptsFromPaths(promptPaths, metadataByPath);
		time("reload-update-prompts");
		for (const p of this.additionalPromptTemplatePaths) {
			if (isLocalPath(p) && !existsSync(p) && !this.promptDiagnostics.some((d) => d.path === p)) {
				this.promptDiagnostics.push({ type: "error", message: "Prompt template path does not exist", path: p });
			}
		}

		const themePaths = this.noThemes
			? this.mergePaths(cliEnabledThemes, this.additionalThemePaths)
			: this.mergePaths([...cliEnabledThemes, ...enabledThemes], this.additionalThemePaths);

		this.lastThemePaths = themePaths;
		this.updateThemesFromPaths(themePaths, metadataByPath);
		time("reload-update-themes");
		for (const p of this.additionalThemePaths) {
			if (isLocalPath(p) && !existsSync(p) && !this.themeDiagnostics.some((d) => d.path === p)) {
				this.themeDiagnostics.push({ type: "error", message: "Theme path does not exist", path: p });
			}
		}

		const agentsFiles = {
			agentsFiles: this.noContextFiles
				? []
				: loadProjectContextFiles({
						cwd: this.cwd,
						agentDir: this.agentDir,
						noLegacyDiscovery: this.noLegacyDiscovery,
						legacyResult,
					}),
		};
		time("reload-load-context-files");
		const resolvedAgentsFiles = this.agentsFilesOverride ? this.agentsFilesOverride(agentsFiles) : agentsFiles;
		this.agentsFiles = resolvedAgentsFiles.agentsFiles;

		// MEMORY.md discovery — separate from AGENTS.md to keep its <persistent_memory> framing distinct.
		const memorySettings = this.settingsManager.getMemorySettings();
		if (this.noContextFiles || memorySettings.disableInjection) {
			this.memoryFiles = [];
		} else {
			this.memoryFiles = discoverMemoryFiles({
				cwd: this.cwd,
				agentDir: this.agentDir,
				configDirName: CONFIG_DIR_NAME,
			});
		}
		time("reload-load-memory");

		const baseSystemPrompt = resolvePromptInput(
			this.systemPromptSource ?? this.discoverSystemPromptFile(),
			"system prompt",
		);
		this.systemPrompt = this.systemPromptOverride ? this.systemPromptOverride(baseSystemPrompt) : baseSystemPrompt;

		const discoveredAppend =
			this.appendSystemPromptSource === undefined ? this.discoverAppendSystemPromptFile() : undefined;
		const appendSources = this.appendSystemPromptSource ?? (discoveredAppend ? [discoveredAppend] : []);
		const baseAppend = appendSources
			.map((s) => resolvePromptInput(s, "append system prompt"))
			.filter((s): s is string => s !== undefined);
		this.appendSystemPrompt = this.appendSystemPromptOverride
			? this.appendSystemPromptOverride(baseAppend)
			: baseAppend;
	}

	private normalizeExtensionPaths(
		entries: Array<{ path: string; metadata: PathMetadata }>,
	): Array<{ path: string; metadata: PathMetadata }> {
		return entries.map((entry) => ({
			path: this.resolveResourcePath(entry.path),
			metadata: entry.metadata,
		}));
	}

	private updateSkillsFromPaths(skillPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let skillsResult: { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
		if (this.noSkills && skillPaths.length === 0) {
			skillsResult = { skills: [], diagnostics: [] };
		} else {
			skillsResult = loadSkills({
				cwd: this.cwd,
				agentDir: this.agentDir,
				skillPaths,
				includeDefaults: false,
			});
		}
		const resolvedSkills = this.skillsOverride ? this.skillsOverride(skillsResult) : skillsResult;
		this.skills = resolvedSkills.skills.map((skill) => ({
			...skill,
			sourceInfo: this.resolveSourceInfo(
				skill.filePath,
				this.extensionSkillSourceInfos,
				skill.sourceInfo,
				metadataByPath,
			),
		}));
		this.skillsByName = new Map(this.skills.map((s) => [s.name, s]));
		this.skillDiagnostics = resolvedSkills.diagnostics;
	}

	private updatePromptsFromPaths(promptPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let promptsResult: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
		if (this.noPromptTemplates && promptPaths.length === 0) {
			promptsResult = { prompts: [], diagnostics: [] };
		} else {
			const allPrompts = loadPromptTemplates({
				cwd: this.cwd,
				agentDir: this.agentDir,
				promptPaths,
				includeDefaults: false,
			});
			promptsResult = this.dedupePrompts(allPrompts);
		}
		const resolvedPrompts = this.promptsOverride ? this.promptsOverride(promptsResult) : promptsResult;
		this.prompts = resolvedPrompts.prompts.map((prompt) => ({
			...prompt,
			sourceInfo: this.resolveSourceInfo(
				prompt.filePath,
				this.extensionPromptSourceInfos,
				prompt.sourceInfo,
				metadataByPath,
			),
		}));
		this.promptDiagnostics = resolvedPrompts.diagnostics;
	}

	private updateThemesFromPaths(themePaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let themesResult: { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
		if (this.noThemes && themePaths.length === 0) {
			themesResult = { themes: [], diagnostics: [] };
		} else {
			const loaded = this.loadThemes(themePaths, false);
			const deduped = this.dedupeThemes(loaded.themes);
			themesResult = { themes: deduped.themes, diagnostics: [...loaded.diagnostics, ...deduped.diagnostics] };
		}
		const resolvedThemes = this.themesOverride ? this.themesOverride(themesResult) : themesResult;
		this.themes = resolvedThemes.themes.map((theme) => {
			const sourcePath = theme.sourcePath;
			theme.sourceInfo = sourcePath
				? this.resolveSourceInfo(sourcePath, this.extensionThemeSourceInfos, theme.sourceInfo, metadataByPath)
				: theme.sourceInfo;
			return theme;
		});
		this.themeDiagnostics = resolvedThemes.diagnostics;
	}

	private applyExtensionSourceInfo(extensions: Extension[], metadataByPath: Map<string, PathMetadata>): void {
		for (const extension of extensions) {
			extension.sourceInfo =
				this.findSourceInfoForPath(extension.path, undefined, metadataByPath) ??
				this.getDefaultSourceInfoForPath(extension.path);
			for (const command of extension.commands.values()) {
				command.sourceInfo = extension.sourceInfo;
			}
			for (const tool of extension.tools.values()) {
				tool.sourceInfo = extension.sourceInfo;
			}
		}
	}

	private findSourceInfoForPath(
		resourcePath: string,
		extraSourceInfos?: Map<string, SourceInfo>,
		metadataByPath?: Map<string, PathMetadata>,
	): SourceInfo | undefined {
		if (!resourcePath) {
			return undefined;
		}

		if (resourcePath.startsWith("<")) {
			return this.getDefaultSourceInfoForPath(resourcePath);
		}

		const normalizedResourcePath = resolve(resourcePath);
		if (extraSourceInfos) {
			// Walk a precomputed (insertion-ordered, pre-resolved) view so the
			// per-resource lookup avoids re-resolve()-ing every source path.
			// First insertion-ordered prefix match wins — same as the old scan.
			const lookup = getSourceLookup(extraSourceInfos);
			const match = lookup.find(normalizedResourcePath);
			if (match) {
				return { ...match, path: resourcePath };
			}
		}

		if (metadataByPath) {
			// Preserve the original raw-key exact fast path verbatim...
			const exact = metadataByPath.get(normalizedResourcePath) ?? metadataByPath.get(resourcePath);
			if (exact) {
				return createSourceInfo(resourcePath, exact);
			}

			// ...then the insertion-ordered prefix scan, now pre-resolved.
			const match = getSourceLookup(metadataByPath).find(normalizedResourcePath);
			if (match) {
				return createSourceInfo(resourcePath, match);
			}
		}

		return undefined;
	}

	/**
	 * Shared resolution trailer for skills/prompts/themes: prefer an
	 * extension/metadata-derived SourceInfo, then the resource's own
	 * pre-existing sourceInfo, then a path-derived default. Extracted verbatim
	 * from updateSkillsFromPaths/updatePromptsFromPaths/updateThemesFromPaths —
	 * behavior is identical; `existing` is the resource's current sourceInfo.
	 */
	private resolveSourceInfo(
		path: string,
		extraSourceInfos: Map<string, SourceInfo>,
		existing: SourceInfo | undefined,
		metadataByPath: Map<string, PathMetadata> | undefined,
	): SourceInfo {
		return (
			this.findSourceInfoForPath(path, extraSourceInfos, metadataByPath) ??
			existing ??
			this.getDefaultSourceInfoForPath(path)
		);
	}

	private getDefaultSourceInfoForPath(filePath: string): SourceInfo {
		if (filePath.startsWith("<") && filePath.endsWith(">")) {
			return {
				path: filePath,
				source: filePath.slice(1, -1).split(":")[0] || "temporary",
				scope: "temporary",
				origin: "top-level",
			};
		}

		const normalizedPath = resolve(filePath);
		const agentRoots = [
			join(this.agentDir, "skills"),
			join(this.agentDir, "prompts"),
			join(this.agentDir, "themes"),
			join(this.agentDir, "extensions"),
		];
		const projectRoots = [
			join(this.cwd, CONFIG_DIR_NAME, "skills"),
			join(this.cwd, CONFIG_DIR_NAME, "prompts"),
			join(this.cwd, CONFIG_DIR_NAME, "themes"),
			join(this.cwd, CONFIG_DIR_NAME, "extensions"),
		];

		for (const root of agentRoots) {
			if (isUnderPath(normalizedPath, root)) {
				return { path: filePath, source: "local", scope: "user", origin: "top-level", baseDir: root };
			}
		}

		for (const root of projectRoots) {
			if (isUnderPath(normalizedPath, root)) {
				return { path: filePath, source: "local", scope: "project", origin: "top-level", baseDir: root };
			}
		}

		// statSync can throw if the path vanished between checks (TOCTOU) — one
		// unguarded stat must not abort the whole reload(). Fall back to the parent.
		let baseDir: string;
		try {
			baseDir = statSync(normalizedPath).isDirectory() ? normalizedPath : resolve(normalizedPath, "..");
		} catch {
			baseDir = resolve(normalizedPath, "..");
		}
		return {
			path: filePath,
			source: "local",
			scope: "temporary",
			origin: "top-level",
			baseDir,
		};
	}

	private mergePaths(primary: string[], additional: string[]): string[] {
		const merged: string[] = [];
		const seen = new Set<string>();

		for (const p of [...primary, ...additional]) {
			const resolved = this.resolveResourcePath(p);
			const canonicalPath = canonicalizePath(resolved);
			if (seen.has(canonicalPath)) continue;
			seen.add(canonicalPath);
			merged.push(resolved);
		}

		return merged;
	}

	private resolveResourcePath(p: string): string {
		const trimmed = p.trim();
		let expanded = trimmed;
		if (trimmed === "~") {
			expanded = homedir();
		} else if (trimmed.startsWith("~/")) {
			expanded = join(homedir(), trimmed.slice(2));
		} else if (trimmed.startsWith("~")) {
			expanded = join(homedir(), trimmed.slice(1));
		}
		return resolve(this.cwd, expanded);
	}

	private loadThemes(
		paths: string[],
		includeDefaults: boolean = true,
	): {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	} {
		const themes: Theme[] = [];
		const diagnostics: ResourceDiagnostic[] = [];
		if (includeDefaults) {
			const defaultDirs = [join(this.agentDir, "themes"), join(this.cwd, CONFIG_DIR_NAME, "themes")];

			for (const dir of defaultDirs) {
				this.loadThemesFromDir(dir, themes, diagnostics);
			}
		}

		for (const p of paths) {
			const resolved = resolve(this.cwd, p);
			if (!existsSync(resolved)) {
				diagnostics.push({ type: "warning", message: "theme path does not exist", path: resolved });
				continue;
			}

			try {
				const stats = statSync(resolved);
				if (stats.isDirectory()) {
					this.loadThemesFromDir(resolved, themes, diagnostics);
				} else if (stats.isFile() && resolved.endsWith(".json")) {
					this.loadThemeFromFile(resolved, themes, diagnostics);
				} else {
					diagnostics.push({ type: "warning", message: "theme path is not a json file", path: resolved });
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to read theme path";
				diagnostics.push({ type: "warning", message, path: resolved });
			}
		}

		return { themes, diagnostics };
	}

	private loadThemesFromDir(dir: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
		if (!existsSync(dir)) {
			return;
		}

		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				let isFile = entry.isFile();
				if (entry.isSymbolicLink()) {
					try {
						isFile = statSync(join(dir, entry.name)).isFile();
					} catch {
						continue;
					}
				}
				if (!isFile) {
					continue;
				}
				if (!entry.name.endsWith(".json")) {
					continue;
				}
				this.loadThemeFromFile(join(dir, entry.name), themes, diagnostics);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read theme directory";
			diagnostics.push({ type: "warning", message, path: dir });
		}
	}

	private loadThemeFromFile(filePath: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
		try {
			themes.push(loadThemeFromPath(filePath));
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to load theme";
			diagnostics.push({ type: "warning", message, path: filePath });
		}
	}

	private async loadExtensionFactories(runtime: ExtensionRuntime): Promise<{
		extensions: Extension[];
		errors: Array<{ path: string; error: string }>;
	}> {
		const extensions: Extension[] = [];
		const errors: Array<{ path: string; error: string }> = [];

		for (const [index, factory] of this.extensionFactories.entries()) {
			const extensionPath = `<inline:${index + 1}>`;
			try {
				const extension = await loadExtensionFromFactory(factory, this.cwd, this.eventBus, runtime, extensionPath);
				extensions.push(extension);
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to load extension";
				errors.push({ path: extensionPath, error: message });
			}
		}

		return { extensions, errors };
	}

	private dedupePrompts(prompts: PromptTemplate[]): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		const seen = new Map<string, PromptTemplate>();
		const diagnostics: ResourceDiagnostic[] = [];

		for (const prompt of prompts) {
			const existing = seen.get(prompt.name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "/${prompt.name}" collision`,
					path: prompt.filePath,
					collision: {
						resourceType: "prompt",
						name: prompt.name,
						winnerPath: existing.filePath,
						loserPath: prompt.filePath,
					},
				});
			} else {
				seen.set(prompt.name, prompt);
			}
		}

		return { prompts: Array.from(seen.values()), diagnostics };
	}

	private dedupeThemes(themes: Theme[]): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		const seen = new Map<string, Theme>();
		const diagnostics: ResourceDiagnostic[] = [];

		for (const t of themes) {
			const name = t.name ?? "unnamed";
			const existing = seen.get(name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "${name}" collision`,
					path: t.sourcePath,
					collision: {
						resourceType: "theme",
						name,
						winnerPath: existing.sourcePath ?? "<builtin>",
						loserPath: t.sourcePath ?? "<builtin>",
					},
				});
			} else {
				seen.set(name, t);
			}
		}

		return { themes: Array.from(seen.values()), diagnostics };
	}

	private discoverSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "SYSTEM.md");
		if (existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	private discoverAppendSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
		if (existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "APPEND_SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	private detectExtensionConflicts(extensions: Extension[]): Array<{ path: string; message: string }> {
		const conflicts: Array<{ path: string; message: string }> = [];

		// Track which extension registered each tool and flag
		const toolOwners = new Map<string, string>();
		const flagOwners = new Map<string, string>();

		for (const ext of extensions) {
			// Check tools
			for (const toolName of ext.tools.keys()) {
				const existingOwner = toolOwners.get(toolName);
				if (existingOwner && existingOwner !== ext.path) {
					conflicts.push({
						path: ext.path,
						message: `Tool "${toolName}" conflicts with ${existingOwner}`,
					});
				} else {
					toolOwners.set(toolName, ext.path);
				}
			}

			// Check flags
			for (const flagName of ext.flags.keys()) {
				const existingOwner = flagOwners.get(flagName);
				if (existingOwner && existingOwner !== ext.path) {
					conflicts.push({
						path: ext.path,
						message: `Flag "--${flagName}" conflicts with ${existingOwner}`,
					});
				} else {
					flagOwners.set(flagName, ext.path);
				}
			}
		}

		return conflicts;
	}
}
