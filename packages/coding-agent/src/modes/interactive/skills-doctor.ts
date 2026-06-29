import * as os from "node:os";
import * as path from "node:path";
import type { ResourceDiagnostic } from "../../core/diagnostics.ts";
import type { ResolvedSkillDiscoverySettings, SettingsManager } from "../../core/settings-manager.ts";
import type { Skill } from "../../core/skills.ts";
import { formatDisplayPath, resolveOrientingCwdLabel } from "./display-utils.ts";
import { theme } from "./theme/theme.ts";

export interface SkillsDoctorInput {
	cwd: string;
	skills: readonly Skill[];
	diagnostics: readonly ResourceDiagnostic[];
	/** Full winner/loser paths (default report is source-level only). */
	verbose?: boolean;
	/** Current discovery opt-outs — enables fix hints in the doctor report. */
	discovery?: ResolvedSkillDiscoverySettings;
}

export type SkillsDoctorFixAction = "noClaudeCode" | "noLegacy";

export interface SkillsDoctorFixPlan {
	actions: SkillsDoctorFixAction[];
	claudeLosers: number;
	codexLosers: number;
	geminiLosers: number;
}

interface CollisionStats {
	claudeLosers: number;
	codexLosers: number;
	geminiLosers: number;
	homeProjectWins: number;
}

export interface SkillDiagnosticCounts {
	duplicateNames: number;
	collisionRows: number;
	warnings: number;
	errors: number;
}

export function tallySkillDiagnostics(diagnostics: readonly ResourceDiagnostic[]): SkillDiagnosticCounts {
	const names = new Set<string>();
	let collisionRows = 0;
	let warnings = 0;
	let errors = 0;
	for (const d of diagnostics) {
		if (d.type === "collision" && d.collision) {
			names.add(d.collision.name);
			collisionRows++;
		} else if (d.type === "error") {
			errors++;
		} else if (d.type === "warning") {
			warnings++;
		}
	}
	return { duplicateNames: names.size, collisionRows, warnings, errors };
}

interface CollisionGroup {
	name: string;
	winnerPath: string;
	winnerSource?: string;
	losers: Array<{ path: string; source?: string }>;
}

function groupCollisions(diagnostics: readonly ResourceDiagnostic[]): CollisionGroup[] {
	const byName = new Map<string, CollisionGroup>();
	for (const d of diagnostics) {
		if (d.type !== "collision" || !d.collision) continue;
		const { name, winnerPath, loserPath, winnerSource, loserSource } = d.collision;
		let group = byName.get(name);
		if (!group) {
			group = { name, winnerPath, winnerSource, losers: [] };
			byName.set(name, group);
		}
		group.losers.push({ path: loserPath, source: loserSource });
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function pathTag(p: string): string {
	return formatDisplayPath(p).replace(/\\/g, "/");
}

function cwdTag(cwd: string): string {
	return resolveOrientingCwdLabel(cwd, null);
}

function loserSourceLabel(loser: { path: string; source?: string }): string {
	if (loser.source) return loser.source;
	const normalized = loser.path.replace(/\\/g, "/");
	if (normalized.includes("/.codex/")) return "codex";
	if (normalized.includes("/.claude/")) return "claude";
	if (normalized.includes("/.gemini/")) return "gemini";
	if (normalized.includes("/.pit/agent/")) return "pit-agent";
	if (normalized.includes("/.pit/skills")) return "pit-project";
	return "path";
}

function summarizeIgnoredDirs(groups: CollisionGroup[]): Array<{ label: string; count: number }> {
	const counts = new Map<string, number>();
	for (const g of groups) {
		for (const loser of g.losers) {
			const normalized = loser.path.replace(/\\/g, "/");
			let label = pathTag(loser.path);
			if (normalized.includes("/.codex/skills")) label = "~/.codex/skills";
			else if (normalized.includes("/.claude/skills")) label = "~/.claude/skills";
			else if (normalized.includes("/.gemini/skills")) label = "~/.gemini/skills";
			else if (normalized.includes("/.pit/agent/skills")) label = "~/.pit/agent/skills";
			else if (normalized.includes("/.pit/skills")) label = "~/.pit/skills";
			counts.set(label, (counts.get(label) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.map(([label, count]) => ({ label, count }))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function loserDirPattern(losers: CollisionGroup["losers"], fragment: string): number {
	return losers.filter((l) => l.path.includes(fragment)).length;
}

function tallyCollisionStats(cwd: string, groups: CollisionGroup[]): CollisionStats {
	const home = os.homedir();
	const resolvedCwd = path.resolve(cwd);
	let claudeLosers = 0;
	let codexLosers = 0;
	let geminiLosers = 0;
	let homeProjectWins = 0;
	for (const g of groups) {
		claudeLosers += loserDirPattern(g.losers, `${path.sep}.claude${path.sep}skills`);
		codexLosers += loserDirPattern(g.losers, `${path.sep}.codex${path.sep}skills`);
		geminiLosers += loserDirPattern(g.losers, `${path.sep}.gemini${path.sep}skills`);
		if (resolvedCwd === home && g.winnerPath.includes(`${path.sep}.pit${path.sep}skills`)) {
			homeProjectWins += 1;
		}
	}
	return { claudeLosers, codexLosers, geminiLosers, homeProjectWins };
}

/** Plan safe settings-based fixes for duplicate skill trees. */
export function planSkillsDoctorFix(
	diagnostics: readonly ResourceDiagnostic[],
	discovery: ResolvedSkillDiscoverySettings,
): SkillsDoctorFixPlan {
	const stats = tallyCollisionStats(os.homedir(), groupCollisions(diagnostics));
	const actions: SkillsDoctorFixAction[] = [];
	if ((stats.codexLosers > 0 || stats.geminiLosers > 0) && !discovery.noLegacy) {
		actions.push("noLegacy");
	}
	if (stats.claudeLosers > 0 && !discovery.noClaudeCode) {
		actions.push("noClaudeCode");
	}
	return {
		actions,
		claudeLosers: stats.claudeLosers,
		codexLosers: stats.codexLosers,
		geminiLosers: stats.geminiLosers,
	};
}

export function applySkillsDoctorFix(settingsManager: SettingsManager, plan: SkillsDoctorFixPlan): string[] {
	const applied: string[] = [];
	for (const action of plan.actions) {
		if (action === "noLegacy") {
			settingsManager.setSkillDiscoveryNoLegacy(true);
			applied.push("skillDiscovery.noLegacy = true");
		} else if (action === "noClaudeCode") {
			settingsManager.setSkillDiscoveryNoClaudeCode(true);
			applied.push("skillDiscovery.noClaudeCode = true");
		}
	}
	return applied;
}

export function formatSkillsDoctorFixHint(plan: SkillsDoctorFixPlan): string | null {
	if (plan.actions.length === 0) return null;
	return "/skills doctor fix — disable duplicate trees in settings";
}

export function formatSkillsDoctorFixResult(
	before: SkillDiagnosticCounts,
	after: SkillDiagnosticCounts,
	applied: string[],
): string {
	let out = `${theme.bold("Skills doctor fix")}\n\n`;
	if (applied.length === 0) {
		out += `${theme.fg("muted", "Nothing to apply — duplicate trees are already opted out.")}\n`;
		return out;
	}
	for (const line of applied) {
		out += `${theme.fg("success", "✓")} ${theme.fg("dim", line)}\n`;
	}
	out += "\n";
	if (before.duplicateNames > 0 || after.duplicateNames > 0) {
		out += `${theme.fg("dim", "Duplicates:")} ${before.duplicateNames} names → ${after.duplicateNames} names\n`;
	}
	if (before.warnings > 0 || after.warnings > 0) {
		out += `${theme.fg("dim", "Warnings:")} ${before.warnings} → ${after.warnings}\n`;
	}
	out += `\n${theme.fg("muted", "Reloaded skills. Run /skills doctor to verify.")}`;
	return out;
}

function buildRecommendations(
	cwd: string,
	groups: CollisionGroup[],
	warnings: readonly ResourceDiagnostic[],
	fixPlan?: SkillsDoctorFixPlan,
): string[] {
	const tips: string[] = [];
	const stats = tallyCollisionStats(cwd, groups);

	if (stats.claudeLosers > 0) {
		if (fixPlan?.actions.includes("noClaudeCode")) {
			tips.push(
				`${stats.claudeLosers} ignored under ~/.claude/skills — run /skills doctor fix to opt out in settings`,
			);
		} else {
			tips.push(
				`${stats.claudeLosers} ignored cop${stats.claudeLosers === 1 ? "y" : "ies"} under ~/.claude/skills — already opted out or remove duplicates`,
			);
		}
	}
	if (stats.codexLosers > 0) {
		if (fixPlan?.actions.includes("noLegacy")) {
			tips.push(
				`${stats.codexLosers} ignored under ~/.codex/skills — run /skills doctor fix to opt out in settings`,
			);
		} else {
			tips.push(
				`${stats.codexLosers} ignored cop${stats.codexLosers === 1 ? "y" : "ies"} under ~/.codex/skills — already opted out or remove duplicates`,
			);
		}
	}
	if (stats.geminiLosers > 0) {
		if (fixPlan?.actions.includes("noLegacy")) {
			tips.push(`${stats.geminiLosers} ignored under ~/.gemini/skills — run /skills doctor fix to opt out`);
		} else {
			tips.push(`${stats.geminiLosers} ignored under ~/.gemini/skills — already opted out or prune the tree`);
		}
	}
	if (stats.homeProjectWins > 0) {
		tips.push(
			`session cwd is ${cwdTag(cwd)} but ${stats.homeProjectWins} skill${stats.homeProjectWins === 1 ? "" : "s"} win from ~/.pit/skills — launch pit from the project repo`,
		);
	}
	if (groups.length === 0 && warnings.length === 0) {
		tips.push("no duplicate names — catalog is clean");
	}
	return tips;
}

/** Minimal one-line hint for quiet startup when skill diagnostics exist. */
export function formatSkillsQuietStartupHint(diagnostics: readonly ResourceDiagnostic[]): string | null {
	const counts = tallySkillDiagnostics(diagnostics);
	if (counts.collisionRows === 0 && counts.warnings === 0 && counts.errors === 0) {
		return null;
	}
	const parts: string[] = [];
	if (counts.duplicateNames > 0) {
		parts.push(`${counts.duplicateNames} dup`);
	}
	if (counts.warnings > 0) {
		parts.push(`${counts.warnings} warn`);
	}
	if (counts.errors > 0) {
		parts.push(`${counts.errors} err`);
	}
	return `${parts.join(" · ")} — /skills doctor`;
}

/** Short summary for `/skills`. */
export function formatSkillsDoctorBrief(input: SkillsDoctorInput): string {
	const collisions = input.diagnostics.filter((d) => d.type === "collision");
	const warnings = input.diagnostics.filter((d) => d.type === "warning");
	const errors = input.diagnostics.filter((d) => d.type === "error");

	let out = `${theme.bold("Skills")}\n\n`;
	out += `${theme.fg("dim", "Loaded:")} ${input.skills.length}\n`;
	out += `${theme.fg("dim", "Session cwd:")} ${cwdTag(input.cwd)}\n`;
	if (collisions.length > 0) {
		out += `${theme.fg("dim", "Duplicates ignored:")} ${collisions.length} (${groupCollisions(input.diagnostics).length} names)\n`;
	}
	if (warnings.length > 0) {
		out += `${theme.fg("dim", "Warnings:")} ${warnings.length}\n`;
	}
	if (errors.length > 0) {
		out += `${theme.fg("dim", "Errors:")} ${errors.length}\n`;
	}
	out += `\n${theme.fg("muted", "Run /skills doctor for the summary; /skills doctor verbose for paths.")}`;
	return out;
}

/** Full report for `/skills doctor`. */
export function formatSkillsDoctorReport(input: SkillsDoctorInput): string {
	const groups = groupCollisions(input.diagnostics);
	const warnings = input.diagnostics.filter((d) => d.type === "warning");
	const errors = input.diagnostics.filter((d) => d.type === "error");
	const collisionCount = input.diagnostics.filter((d) => d.type === "collision").length;

	let out = `${theme.bold("Skills doctor")}\n\n`;
	out += `${theme.fg("dim", "Loaded:")} ${theme.fg("accent", String(input.skills.length))} unique names\n`;
	out += `${theme.fg("dim", "Session cwd:")} ${cwdTag(input.cwd)}\n`;
	out += `${theme.fg("dim", "Duplicates ignored:")} ${collisionCount} (${groups.length} names)\n`;
	out += `${theme.fg("dim", "Precedence:")} first source wins — project → user (~/.pit/agent) → legacy → ~/.claude\n\n`;

	if (groups.length > 0) {
		const ignoredDirs = summarizeIgnoredDirs(groups);
		if (ignoredDirs.length > 0) {
			out += `${theme.bold("Ignored by tree")}\n`;
			for (const row of ignoredDirs) {
				out += `${theme.fg("dim", "  ")}${row.label} ${theme.fg("muted", `×${row.count}`)}\n`;
			}
			out += "\n";
		}

		out += `${theme.bold("Collisions")}\n`;
		for (const g of groups) {
			const winSrc = g.winnerSource ? theme.fg("dim", ` (${g.winnerSource})`) : "";
			const loserSources = [...new Set(g.losers.map((l) => loserSourceLabel(l)))].join(", ");
			out += `${theme.fg("success", "✓")} ${theme.fg("accent", g.name)}${winSrc}`;
			out += `${theme.fg("muted", ` — ${g.losers.length} ignored (${loserSources})`)}\n`;
			if (input.verbose) {
				out += `${theme.fg("dim", "    ")}${pathTag(g.winnerPath)}\n`;
				for (const loser of g.losers) {
					const src = loser.source ? theme.fg("dim", ` (${loser.source})`) : "";
					out += `${theme.fg("warning", "✗")} ${theme.fg("muted", "ignored")}${src}\n`;
					out += `${theme.fg("dim", "    ")}${pathTag(loser.path)}\n`;
				}
			}
		}
		if (!input.verbose) {
			out += `${theme.fg("dim", "  /skills doctor verbose for paths\n")}`;
		}
		out += "\n";
	}

	if (warnings.length > 0 || errors.length > 0) {
		out += `${theme.bold("Other issues")}\n`;
		for (const d of [...errors, ...warnings]) {
			const color = d.type === "error" ? "error" : "warning";
			const where = d.path ? ` ${pathTag(d.path)}` : "";
			out += `${theme.fg(color, `• ${d.message}`)}${theme.fg("dim", where)}\n`;
		}
		out += "\n";
	}

	const discovery = input.discovery ?? { noClaudeCode: false, noLegacy: false };
	const fixPlan = planSkillsDoctorFix(input.diagnostics, discovery);
	const fixHint = formatSkillsDoctorFixHint(fixPlan);
	if (fixHint) {
		out += `${theme.fg("accent", fixHint)}\n\n`;
	}

	const tips = buildRecommendations(input.cwd, groups, warnings, fixPlan);
	if (tips.length > 0) {
		out += `${theme.bold("Recommendations")}\n`;
		for (const tip of tips) {
			out += `${theme.fg("muted", `• ${tip}`)}\n`;
		}
	}

	return out;
}
