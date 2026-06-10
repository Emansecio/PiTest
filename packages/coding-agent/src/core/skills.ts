import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "fs";
import ignore from "ignore";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { canonicalizePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { createMtimeParseCache } from "./mtime-cache.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";

/** Max name length per spec */
const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
const MAX_DESCRIPTION_LENGTH = 1024;

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

// Cache directory listings keyed by dir mtime. A directory's mtime changes
// whenever an entry is added, removed, or renamed — exactly the cases that
// alter readdirSync's output — so a same-mtime hit can safely reuse the prior
// listing. Per-file content changes do NOT bump dir mtime, but they are picked
// up independently by the file-level mtime cache in loadSkillFromFile, so the
// walk still re-parses changed skill files. Returns null on stat/read failure
// so callers fall through to their existing try/catch behavior.
const dirEntriesCache = new Map<string, { mtimeMs: number; entries: Dirent<string>[] }>();

function readDirEntriesCached(dir: string): Dirent<string>[] {
	const stat = statSync(dir);
	const cached = dirEntriesCache.get(dir);
	if (cached && cached.mtimeMs === stat.mtimeMs) return cached.entries;
	const entries = readdirSync(dir, { withFileTypes: true });
	dirEntriesCache.set(dir, { mtimeMs: stat.mtimeMs, entries });
	return entries;
}

const ignoreFileLinesCache = new Map<string, { mtimeMs: number; lines: string[] }>();

function readIgnoreFileLines(ignorePath: string): string[] | null {
	try {
		const stat = statSync(ignorePath);
		const cached = ignoreFileLinesCache.get(ignorePath);
		if (cached && cached.mtimeMs === stat.mtimeMs) return cached.lines;
		const lines = readFileSync(ignorePath, "utf-8").split(/\r?\n/);
		ignoreFileLinesCache.set(ignorePath, { mtimeMs: stat.mtimeMs, lines });
		return lines;
	} catch {
		return null;
	}
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		const lines = readIgnoreFileLines(ignorePath);
		if (!lines) continue;
		const patterns = lines
			.map((line) => prefixIgnorePattern(line, prefix))
			.filter((line): line is string => Boolean(line));
		if (patterns.length > 0) {
			ig.add(patterns);
		}
	}
}

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
}

export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Validate skill name per Agent Skills spec.
 * Returns array of validation error messages (empty if valid).
 */
function validateName(name: string): string[] {
	const errors: string[] = [];

	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push(`name must not start or end with a hyphen`);
	}

	if (name.includes("--")) {
		errors.push(`name must not contain consecutive hyphens`);
	}

	return errors;
}

/**
 * Validate description per Agent Skills spec.
 */
function validateDescription(description: string | undefined): string[] {
	const errors: string[] = [];

	if (!description || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
}

function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	if (source === "user" || source === "project") {
		return createSyntheticSourceInfo(filePath, { source: "local", scope: source, baseDir });
	}
	if (source === "path") {
		return createSyntheticSourceInfo(filePath, { source: "local", baseDir });
	}
	return createSyntheticSourceInfo(filePath, { source, baseDir });
}

/**
 * Load skills from a directory.
 *
 * Discovery rules:
 * - if a directory contains SKILL.md, treat it as a skill root and do not recurse further
 * - otherwise, load direct .md children in the root
 * - recurse into subdirectories to find SKILL.md
 */
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const { dir, source } = options;
	return loadSkillsFromDirInternal(dir, source, true);
}

function loadSkillsFromDirInternal(
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): LoadSkillsResult {
	const skills: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { skills, diagnostics };
	}

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readDirEntriesCached(dir);

		for (const entry of entries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (!isFile || ig.ignores(relPath)) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
			return { skills, diagnostics };
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) {
				continue;
			}

			// Skip node_modules to avoid scanning dependencies
			if (entry.name === "node_modules") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			// For symlinks, check if they point to a directory and follow them
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					// Broken symlink, skip it
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDirectory ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) {
				continue;
			}

			if (isDirectory) {
				const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root);
				skills.push(...subResult.skills);
				diagnostics.push(...subResult.diagnostics);
				continue;
			}

			if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
		}
	} catch {}

	return { skills, diagnostics };
}

// mtime-keyed cache of the expensive read+parse step. The Skill object itself
// is rebuilt fresh per call (cheap) so source-dependent fields stay correct.
const skillFrontmatterCache = createMtimeParseCache<{ frontmatter: SkillFrontmatter }>((rawContent) => ({
	frontmatter: parseFrontmatter<SkillFrontmatter>(rawContent).frontmatter,
}));

function loadSkillFromFile(
	filePath: string,
	source: string,
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];

	try {
		const { frontmatter } = skillFrontmatterCache(filePath);
		const skillDir = dirname(filePath);
		const parentDirName = basename(skillDir);

		// Validate description
		const descErrors = validateDescription(frontmatter.description);
		for (const error of descErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		// Use name from frontmatter, or fall back to parent directory name
		const name = frontmatter.name || parentDirName;

		// Validate name
		const nameErrors = validateName(name);
		for (const error of nameErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		// Still load the skill even with warnings (unless description is completely missing)
		if (!frontmatter.description || frontmatter.description.trim() === "") {
			return { skill: null, diagnostics };
		}

		return {
			skill: {
				name,
				description: frontmatter.description,
				filePath,
				baseDir: skillDir,
				sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
				disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			},
			diagnostics,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse skill file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { skill: null, diagnostics };
	}
}

/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /name commands).
 */
export function formatSkillsForPrompt(skills: Skill[], maxSkills = 100, cwd?: string): string {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

	if (visibleSkills.length === 0) {
		return "";
	}

	const shown = visibleSkills.slice(0, maxSkills);
	const omitted = visibleSkills.length - shown.length;

	// Roots to relativize against. Most skill paths live under cwd or the
	// agent dir (e.g. ~/.pit/skills). Shortest representation wins, falling
	// back to absolute when not under either root.
	const agentDir = getAgentDir();
	const roots: string[] = [];
	if (cwd) roots.push(resolve(cwd));
	if (agentDir) roots.push(resolve(agentDir));
	const home = homedir();
	if (home) roots.push(resolve(home));

	const shortenPath = (absPath: string): string => {
		let best = absPath;
		for (const root of roots) {
			if (!absPath.startsWith(root)) continue;
			const rel = relative(root, absPath);
			if (rel && !rel.startsWith("..") && rel.length + 2 < best.length) {
				// Tag home-relative with ~ so it stays unambiguous; cwd/agentDir
				// resolve via the read tool's path aliases.
				best = root === home ? `~/${toPosixPath(rel)}` : toPosixPath(rel);
			}
		}
		return best;
	};

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const skill of shown) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(shortenPath(skill.filePath))}</location>`);
		lines.push("  </skill>");
	}

	if (omitted > 0) {
		lines.push(`  <!-- ${omitted} more skill(s) installed but not shown here (listing caps at ${maxSkills}). -->`);
	}

	lines.push("</available_skills>");

	return lines.join("\n");
}

const XML_ESCAPE_MAP: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&apos;",
};
const XML_ESCAPE_RE = /[&<>"']/g;

function escapeXml(str: string): string {
	return str.replace(XML_ESCAPE_RE, (ch) => XML_ESCAPE_MAP[ch]);
}

export interface LoadSkillsOptions {
	/** Working directory for project-local skills. */
	cwd: string;
	/** Agent config directory for global skills. */
	agentDir: string;
	/** Explicit skill paths (files or directories) */
	skillPaths: string[];
	/** Include default skills directories. */
	includeDefaults: boolean;
}

function normalizePath(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
	return trimmed;
}

/**
 * Resolve the Claude Code skills directory (`~/.claude/skills/`), or null when
 * the user opted out via `PIT_DISABLE_CLAUDE_CODE_SKILLS=1`. The path is not
 * checked for existence here — the caller decides whether to load.
 *
 * Lives here rather than `config.ts` because it is loader-internal: only the
 * skill discovery path consumes it, and folding it into the config surface
 * would suggest a generality that does not exist.
 */
export function getClaudeCodeSkillsDir(): string | null {
	if (process.env.PIT_DISABLE_CLAUDE_CODE_SKILLS === "1") return null;
	return join(homedir(), ".claude", "skills");
}

function resolveSkillPath(p: string, cwd: string): string {
	const normalized = normalizePath(p);
	return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation diagnostics.
 */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	const { cwd, agentDir, skillPaths, includeDefaults } = options;

	// Resolve agentDir - if not provided, use default from config
	const resolvedAgentDir = agentDir ?? getAgentDir();

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	function addSkills(result: LoadSkillsResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			// Resolve symlinks to detect duplicate files
			const realPath = canonicalizePath(skill.filePath);

			// Skip silently if we've already loaded this exact file (via symlink)
			if (realPathSet.has(realPath)) {
				continue;
			}

			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${skill.name}" collision`,
					path: skill.filePath,
					collision: {
						resourceType: "skill",
						name: skill.name,
						winnerPath: existing.filePath,
						loserPath: skill.filePath,
					},
				});
			} else {
				skillMap.set(skill.name, skill);
				realPathSet.add(realPath);
			}
		}
	}

	if (includeDefaults) {
		addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true));
		addSkills(loadSkillsFromDirInternal(resolve(cwd, CONFIG_DIR_NAME, "skills"), "project", true));
		// Claude Code skills (~/.claude/skills/) are loaded as a tertiary user
		// source — they only fill gaps left by the agent's own skills dir and
		// project skills, so pit-curated and project-scoped skills always win
		// on a name collision. The Skill format is byte-compatible with our
		// own (same SKILL.md + YAML frontmatter), so they slot in without
		// translation. Opt-out: PIT_DISABLE_CLAUDE_CODE_SKILLS=1.
		const claudeSkillsDir = getClaudeCodeSkillsDir();
		if (claudeSkillsDir && existsSync(claudeSkillsDir)) {
			addSkills(loadSkillsFromDirInternal(claudeSkillsDir, "claude-code", true));
		}
	}

	const userSkillsDir = join(resolvedAgentDir, "skills");
	const projectSkillsDir = resolve(cwd, CONFIG_DIR_NAME, "skills");

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
			if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
		}
		return "path";
	};

	for (const rawPath of skillPaths) {
		const resolvedPath = resolveSkillPath(rawPath, cwd);
		if (!existsSync(resolvedPath)) {
			allDiagnostics.push({ type: "warning", message: "skill path does not exist", path: resolvedPath });
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = loadSkillFromFile(resolvedPath, source);
				if (result.skill) {
					addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
				} else {
					allDiagnostics.push(...result.diagnostics);
				}
			} else {
				allDiagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: resolvedPath });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read skill path";
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	return {
		skills: Array.from(skillMap.values()),
		diagnostics: [...allDiagnostics, ...collisionDiagnostics],
	};
}
