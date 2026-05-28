import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import chalk from "chalk";

export interface LegacyRuleFile {
	path: string;
	content: string;
	origin: string;
}

export interface LegacyDiscoveryResult {
	ruleFiles: LegacyRuleFile[];
	skillDirs: string[];
}

export interface DiscoverLegacyResourcesOptions {
	cwd: string;
	agentDir: string;
	/** Already-seen absolute paths to skip (dedupe against AGENTS.md/CLAUDE.md found by existing loader). */
	seenPaths?: Set<string>;
}

/**
 * Strip a leading YAML frontmatter block: ---\n...\n---\n
 */
function stripFrontmatter(text: string): string {
	if (!text.startsWith("---")) {
		return text;
	}
	const rest = text.slice(3);
	const nlAfterOpen = rest.indexOf("\n");
	if (nlAfterOpen === -1) {
		return text;
	}
	const afterOpen = rest.slice(nlAfterOpen + 1);
	const closeMatch = afterOpen.match(/^---[ \t]*\r?\n/m);
	if (!closeMatch || closeMatch.index === undefined) {
		return text;
	}
	const closeStart = closeMatch.index;
	// Ensure the closing --- is at the start of a line.
	if (closeStart !== 0 && afterOpen[closeStart - 1] !== "\n") {
		return text;
	}
	return afterOpen.slice(closeStart + closeMatch[0].length);
}

function safeReadFile(filePath: string): string | null {
	try {
		return readFileSync(filePath, "utf-8");
	} catch (error) {
		console.warn(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
		return null;
	}
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch (error) {
		console.warn(chalk.yellow(`Warning: Could not read directory ${dir}: ${error}`));
		return [];
	}
}

function isFile(filePath: string): boolean {
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function isDir(dirPath: string): boolean {
	try {
		return statSync(dirPath).isDirectory();
	} catch {
		return false;
	}
}

interface RuleSource {
	/** Path relative to the root being scanned. */
	rel: string;
	origin: string;
	/** If true, strip YAML frontmatter from the content. */
	stripFrontmatter?: boolean;
}

interface DirRuleSource {
	/** Directory path relative to the root being scanned. */
	rel: string;
	origin: string;
	/** File extensions to match (without leading dot). */
	extensions: string[];
	/** Optional filename suffix filter (e.g. ".instructions.md"). */
	suffix?: string;
	/** If true, strip YAML frontmatter from each file's content. */
	stripFrontmatter?: boolean;
}

// Single rule files to check at each candidate root.
const SINGLE_RULE_SOURCES: RuleSource[] = [
	{ rel: join(".claude", "CLAUDE.md"), origin: "claude" },
	{ rel: ".cursorrules", origin: "cursor" },
	{ rel: ".clinerules", origin: "cline" },
	{ rel: join(".cline", ".clinerules"), origin: "cline" },
	{ rel: join(".gemini", "GEMINI.md"), origin: "gemini" },
	{ rel: "GEMINI.md", origin: "gemini" },
	{ rel: join(".github", "copilot-instructions.md"), origin: "copilot" },
];

// Directories of rule files to scan at each candidate root.
const DIR_RULE_SOURCES: DirRuleSource[] = [
	{
		rel: join(".cursor", "rules"),
		origin: "cursor",
		extensions: ["md", "mdc"],
		stripFrontmatter: true,
	},
	{
		rel: join(".windsurf", "rules"),
		origin: "windsurf",
		extensions: ["md"],
	},
	{
		rel: join(".github", "instructions"),
		origin: "copilot",
		extensions: ["md"],
		suffix: ".instructions.md",
	},
	{
		rel: join(".vscode", "instructions"),
		origin: "vscode",
		extensions: ["md"],
	},
];

// Skill directories to check at each candidate root.
const SKILL_DIR_SOURCES: Array<{ rel: string; origin: string }> = [
	{ rel: join(".claude", "skills"), origin: "claude" },
	{ rel: join(".cursor", "skills"), origin: "cursor" },
	{ rel: join(".codex", "skills"), origin: "codex" },
	{ rel: join(".gemini", "skills"), origin: "gemini" },
];

function canonical(p: string): string {
	return resolve(p);
}

function collectFromRoot(
	root: string,
	result: LegacyDiscoveryResult,
	seenRulePaths: Set<string>,
	seenSkillDirs: Set<string>,
): void {
	for (const src of SINGLE_RULE_SOURCES) {
		const filePath = join(root, src.rel);
		const canon = canonical(filePath);
		if (seenRulePaths.has(canon)) {
			continue;
		}
		if (!existsSync(filePath) || !isFile(filePath)) {
			continue;
		}
		const content = safeReadFile(filePath);
		if (content === null) {
			continue;
		}
		const body = src.stripFrontmatter ? stripFrontmatter(content) : content;
		seenRulePaths.add(canon);
		result.ruleFiles.push({ path: filePath, content: body, origin: src.origin });
	}

	for (const src of DIR_RULE_SOURCES) {
		const dirPath = join(root, src.rel);
		if (!existsSync(dirPath) || !isDir(dirPath)) {
			continue;
		}
		const entries = safeReaddir(dirPath);
		for (const name of entries) {
			if (src.suffix) {
				if (!name.endsWith(src.suffix)) {
					continue;
				}
			} else {
				const dotIdx = name.lastIndexOf(".");
				if (dotIdx === -1) {
					continue;
				}
				const ext = name.slice(dotIdx + 1).toLowerCase();
				if (!src.extensions.includes(ext)) {
					continue;
				}
			}
			const filePath = join(dirPath, name);
			if (!isFile(filePath)) {
				continue;
			}
			const canon = canonical(filePath);
			if (seenRulePaths.has(canon)) {
				continue;
			}
			const content = safeReadFile(filePath);
			if (content === null) {
				continue;
			}
			const body = src.stripFrontmatter ? stripFrontmatter(content) : content;
			seenRulePaths.add(canon);
			result.ruleFiles.push({ path: filePath, content: body, origin: src.origin });
		}
	}

	for (const src of SKILL_DIR_SOURCES) {
		const dirPath = join(root, src.rel);
		const canon = canonical(dirPath);
		if (seenSkillDirs.has(canon)) {
			continue;
		}
		if (!existsSync(dirPath) || !isDir(dirPath)) {
			continue;
		}
		seenSkillDirs.add(canon);
		result.skillDirs.push(dirPath);
	}
}

export function discoverLegacyResources(opts: DiscoverLegacyResourcesOptions): LegacyDiscoveryResult {
	const result: LegacyDiscoveryResult = { ruleFiles: [], skillDirs: [] };

	const seenRulePaths = new Set<string>();
	if (opts.seenPaths) {
		for (const p of opts.seenPaths) {
			seenRulePaths.add(canonical(p));
		}
	}
	const seenSkillDirs = new Set<string>();

	// Global agent dir first.
	if (opts.agentDir && existsSync(opts.agentDir)) {
		collectFromRoot(opts.agentDir, result, seenRulePaths, seenSkillDirs);
	}

	// Walk ancestors from cwd up to filesystem root. Collect into a list first,
	// then process from outermost ancestor inward so closer-scope wins on dedupe ties.
	// Stop traversal at the user's home directory (exclusive) — anything in $HOME
	// that the user actually wants is reached via agentDir, not via ancestor walk.
	const ancestors: string[] = [];
	let currentDir = opts.cwd;
	const root = resolve("/");
	const userHome = (() => {
		try {
			return resolve(homedir());
		} catch {
			return null;
		}
	})();
	while (true) {
		const resolvedCurrent = resolve(currentDir);
		if (userHome && resolvedCurrent === userHome) break;
		ancestors.push(currentDir);
		if (currentDir === root) break;
		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	// Process from outermost (root) to innermost (cwd) so that if duplicate
	// canonical paths appear, the first wins — same ordering intent as
	// loadProjectContextFiles (ancestors unshifted).
	for (let i = ancestors.length - 1; i >= 0; i--) {
		collectFromRoot(ancestors[i], result, seenRulePaths, seenSkillDirs);
	}

	return result;
}
