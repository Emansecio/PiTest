/**
 * Dry-run preview — inspects resolved settings, auth, resources, MCP, and
 * extensions, then prints a human- or machine-readable readiness report.
 *
 * Never executes the agent loop, never calls any provider, never spawns hooks
 * or MCP tools. Auth credentials are checked only by existence in the
 * AuthStorage; no network roundtrips happen.
 *
 * Exit codes:
 *   0  — all checks "ready" or "warning"
 *   1  — at least one check "blocked"
 */

import { existsSync, statSync } from "node:fs";
import chalk from "chalk";
import { CONFIG_DIR_NAME } from "../../config.ts";
import type { AgentSessionServices } from "../../core/agent-session-services.ts";
import { discoverLegacyResources } from "../../core/legacy-discovery.ts";
import { discoverMemoryFiles } from "../../core/memory/index.ts";
import { normalizePermissionMode } from "../../core/permissions/index.ts";

export type DryRunStatus = "ready" | "warning" | "blocked";

export interface DryRunCheck {
	name: string;
	status: DryRunStatus;
	detail: string;
	items?: Array<{ label: string; value: string; status?: DryRunStatus }>;
}

export interface DryRunReport {
	cwd: string;
	agentDir: string;
	overallStatus: DryRunStatus;
	checks: DryRunCheck[];
}

function worst(a: DryRunStatus, b: DryRunStatus): DryRunStatus {
	if (a === "blocked" || b === "blocked") return "blocked";
	if (a === "warning" || b === "warning") return "warning";
	return "ready";
}

function statusGlyph(status: DryRunStatus): string {
	switch (status) {
		case "ready":
			return chalk.green("✓");
		case "warning":
			return chalk.yellow("!");
		case "blocked":
			return chalk.red("✗");
	}
}

export interface BuildDryRunReportOptions {
	services: AgentSessionServices;
	resolvedModel?: import("@pit/ai").Model<any>;
	resolvedToolNames: string[];
}

export function buildDryRunReport(options: BuildDryRunReportOptions): DryRunReport {
	const { services, resolvedModel, resolvedToolNames } = options;
	const { cwd, agentDir, settingsManager, modelRegistry, resourceLoader } = services;
	const checks: DryRunCheck[] = [];

	// --- Working directory
	checks.push({
		name: "Working directory",
		status: existsSync(cwd) ? "ready" : "blocked",
		detail: cwd,
	});

	// --- Agent dir
	checks.push({
		name: "Agent directory",
		status: existsSync(agentDir) ? "ready" : "warning",
		detail: existsSync(agentDir) ? agentDir : `${agentDir} (will be created on first write)`,
	});

	// --- Settings
	const settingsErrors = settingsManager.drainErrors();
	checks.push({
		name: "Settings",
		status: settingsErrors.length > 0 ? "warning" : "ready",
		detail: settingsErrors.length === 0 ? "loaded cleanly" : `${settingsErrors.length} parse error(s)`,
		items: settingsErrors.map((e) => ({ label: e.scope, value: e.error.message, status: "warning" as const })),
	});

	// --- Model & auth
	if (resolvedModel) {
		const auth = modelRegistry.hasConfiguredAuth(resolvedModel);
		checks.push({
			name: "Model & auth",
			status: auth ? "ready" : "blocked",
			detail: `${resolvedModel.provider}/${resolvedModel.id}${auth ? "" : " (missing API key/OAuth)"}`,
		});
	} else {
		checks.push({
			name: "Model & auth",
			status: "blocked",
			detail: "no model resolved (set --model or default in settings)",
		});
	}

	// --- Tools
	checks.push({
		name: "Tools",
		status: resolvedToolNames.length > 0 ? "ready" : "warning",
		detail: resolvedToolNames.length > 0 ? resolvedToolNames.join(", ") : "no tools enabled",
	});

	// --- Extensions
	const extensions = resourceLoader.getExtensions();
	checks.push({
		name: "Extensions",
		status: extensions.errors.length > 0 ? "warning" : "ready",
		detail: `${extensions.extensions.length} loaded, ${extensions.errors.length} error(s)`,
		items: extensions.errors.map((e) => ({ label: e.path, value: e.error, status: "warning" as const })),
	});

	// --- Skills / prompts / themes
	const skills = resourceLoader.getSkills();
	const prompts = resourceLoader.getPrompts();
	const themes = resourceLoader.getThemes();
	checks.push({
		name: "Resources",
		status: "ready",
		detail: `${skills.skills.length} skills, ${prompts.prompts.length} prompts, ${themes.themes.length} themes`,
	});

	// --- Memory
	const memoryFiles = discoverMemoryFiles({ cwd, agentDir, configDirName: CONFIG_DIR_NAME });
	checks.push({
		name: "Memory",
		status: "ready",
		detail: memoryFiles.length === 0 ? "no MEMORY.md found" : `${memoryFiles.length} file(s) discovered`,
		items: memoryFiles.map((f) => ({ label: f.scope, value: f.path })),
	});

	// --- MCP
	const mcpSettings = settingsManager.getMcpSettings();
	const mcpServerNames = Object.keys(mcpSettings.servers ?? {});
	checks.push({
		name: "MCP servers",
		status: "ready",
		detail: mcpServerNames.length === 0 ? "none configured" : `${mcpServerNames.length} configured`,
		items: mcpServerNames.map((name) => {
			const cfg = mcpSettings.servers![name];
			return {
				label: name,
				value: cfg.disabled ? `${cfg.url} (disabled)` : cfg.url,
				status: cfg.disabled ? ("warning" as const) : ("ready" as const),
			};
		}),
	});

	// --- Hooks
	const hooksSettings = settingsManager.getHooksSettings();
	const hookCount =
		(hooksSettings.PreToolUse?.length ?? 0) +
		(hooksSettings.PostToolUse?.length ?? 0) +
		(hooksSettings.UserPromptSubmit?.length ?? 0) +
		(hooksSettings.Stop?.length ?? 0);
	checks.push({
		name: "Hooks",
		status: "ready",
		detail: hookCount === 0 ? "none configured" : `${hookCount} configured`,
		items:
			hookCount === 0
				? []
				: [
						{ label: "PreToolUse", value: String(hooksSettings.PreToolUse?.length ?? 0) },
						{ label: "PostToolUse", value: String(hooksSettings.PostToolUse?.length ?? 0) },
						{ label: "UserPromptSubmit", value: String(hooksSettings.UserPromptSubmit?.length ?? 0) },
						{ label: "Stop", value: String(hooksSettings.Stop?.length ?? 0) },
					],
	});

	// --- Permissions
	const perm = settingsManager.getPermissionSettings();
	const permissionMode = normalizePermissionMode(perm.mode) ?? "auto";
	checks.push({
		name: "Permissions",
		status: "ready",
		detail: `mode=${permissionMode}; allow=${perm.allowPaths?.length ?? 0}; deny=${perm.denyPaths?.length ?? 0}; denyCmd=${perm.denyCommands?.length ?? 0}`,
	});

	// --- Project context files
	const agentsFiles = resourceLoader.getAgentsFiles().agentsFiles;
	checks.push({
		name: "Project context",
		status: "ready",
		detail: agentsFiles.length === 0 ? "no AGENTS.md/CLAUDE.md found" : `${agentsFiles.length} file(s)`,
		items: agentsFiles.map((f) => ({ label: "ctx", value: f.path })),
	});

	// --- Legacy resources (Claude/Codex/Cursor/Cline/Windsurf/Gemini/Copilot/VSCode)
	const seenContextPaths = new Set(agentsFiles.map((f) => f.path));
	const legacy = discoverLegacyResources({ cwd, agentDir, seenPaths: seenContextPaths });
	const originCounts = new Map<string, number>();
	for (const r of legacy.ruleFiles) {
		originCounts.set(r.origin, (originCounts.get(r.origin) ?? 0) + 1);
	}
	const originSummary = [...originCounts.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([o, n]) => `${o}=${n}`)
		.join(" ");
	const totalLegacy = legacy.ruleFiles.length + legacy.skillDirs.length;
	checks.push({
		name: "Legacy resources",
		status: "ready",
		detail:
			totalLegacy === 0
				? "none found"
				: `${legacy.ruleFiles.length} rule file(s), ${legacy.skillDirs.length} skill dir(s)${originSummary ? ` (${originSummary})` : ""}`,
		items: [
			...legacy.ruleFiles.map((r) => ({ label: r.origin, value: r.path })),
			...legacy.skillDirs.map((d) => ({ label: "skills", value: d })),
		],
	});

	const overall = checks.reduce<DryRunStatus>((acc, check) => worst(acc, check.status), "ready");

	return {
		cwd,
		agentDir,
		overallStatus: overall,
		checks,
	};
}

export function formatReportText(report: DryRunReport): string {
	const lines: string[] = [];
	lines.push(chalk.bold(`pi dry-run — ${statusGlyph(report.overallStatus)} ${report.overallStatus.toUpperCase()}`));
	lines.push(`  cwd:       ${report.cwd}`);
	lines.push(`  agentDir:  ${report.agentDir}`);
	lines.push("");
	for (const check of report.checks) {
		lines.push(`${statusGlyph(check.status)} ${chalk.bold(check.name)} — ${check.detail}`);
		for (const item of check.items ?? []) {
			const glyph = item.status ? statusGlyph(item.status) : " ";
			lines.push(`    ${glyph} ${item.label}: ${item.value}`);
		}
	}
	return lines.join("\n");
}

export function formatReportJson(report: DryRunReport): string {
	return JSON.stringify(report, null, 2);
}

export function maybeStatExists(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}
