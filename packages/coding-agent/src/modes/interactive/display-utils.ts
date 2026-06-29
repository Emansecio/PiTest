import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "@pit/tui";
import type { ResourceDiagnostic } from "../../core/resource-loader.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import { parseGitUrl } from "../../utils/git.ts";
import { getCwdRelativePath } from "../../utils/paths.ts";
import { sliceSafe } from "../../utils/surrogate.ts";
import { theme } from "./theme/theme.ts";

/** Hard cap on compact cwd labels so deep paths never crowd adjacent UI. */
export const MAX_COMPACT_CWD_WIDTH = 40;

export function formatDisplayPath(p: string): string {
	const home = os.homedir();
	if (p.startsWith(home)) {
		return `~${p.slice(home.length)}`;
	}
	return p;
}

/**
 * Shorten a path by collapsing its middle, preserving the head and tail.
 * Splits on both separators (Windows and POSIX); returns the input when it
 * already fits or is too short to collapse meaningfully.
 */
export function ellipsizePathMiddle(p: string, maxWidth: number): string {
	if (visibleWidth(p) <= maxWidth) return p;
	const segments = p.split(/[\\/]+/).filter((s) => s.length > 0);
	if (segments.length <= 2) {
		return `…${sliceSafe(p, p.length - (maxWidth - 1))}`;
	}
	const sep = p.includes("\\") ? "\\" : "/";
	const head = segments[0]!;
	let tailCount = 1;
	let candidate = `${head}${sep}…${sep}${segments.slice(segments.length - tailCount).join(sep)}`;
	while (tailCount + 1 < segments.length) {
		const next = `${head}${sep}…${sep}${segments.slice(segments.length - (tailCount + 1)).join(sep)}`;
		if (visibleWidth(next) > maxWidth) break;
		candidate = next;
		tailCount += 1;
	}
	return candidate;
}

/**
 * Compact a cwd for identity lines (welcome, footer). Prefers a path relative to
 * the git repo root (`PiTest/src/…` instead of `~/PiTest/src/…`). Outside a repo,
 * falls back to home-relative form with a mid-path ellipsis.
 */
export function compactCwd(cwd: string, repoDir: string | null): string {
	if (repoDir) {
		const rel = path.relative(repoDir, cwd);
		if (rel === "") return path.basename(repoDir);
		if (!rel.startsWith("..") && rel !== "." && !/^[A-Za-z]:/.test(rel)) {
			const normalized = rel.split(/[\\/]+/).join("/");
			return `${path.basename(repoDir)}/${normalized}`;
		}
	}
	return ellipsizePathMiddle(formatDisplayPath(cwd), MAX_COMPACT_CWD_WIDTH);
}

function isBareHomeLabel(label: string): boolean {
	const trimmed = label.trim();
	return trimmed === "~" || trimmed === "~/" || trimmed === "~\\";
}

export interface WorkspaceCwdLabels {
	/** Session cwd, never empty and never a lone `~`. */
	session: string;
	/** `shell: …` when the launcher cwd differs from the session cwd. */
	shellNote?: string;
}

/**
 * Resolve a cwd for identity lines (welcome, footer). Never returns empty or a
 * bare `~` — home alone reads as `~ (home)`, subpaths stay `~/proj`, repo-relative
 * wins when inside a git root. Falls back to `fallbackCwd` when `cwd` is empty.
 */
export function resolveOrientingCwdLabel(cwd: string, repoDir: string | null, fallbackCwd?: string): string {
	const raw = cwd.trim() || (fallbackCwd?.trim() ?? "");
	if (!raw) return "?";

	let label = compactCwd(raw, repoDir);
	if (!label.trim() || isBareHomeLabel(label)) {
		const home = os.homedir();
		const resolved = path.resolve(raw);
		if (resolved === home) {
			label = "~ (home)";
		} else {
			const rel = formatDisplayPath(resolved);
			if (!isBareHomeLabel(rel)) {
				label = ellipsizePathMiddle(rel, MAX_COMPACT_CWD_WIDTH);
			} else {
				const base = path.basename(resolved);
				label = base || "?";
			}
		}
	}
	return label;
}

/** Build welcome/footer cwd labels, surfacing shell vs session divergence. */
export function buildWorkspaceCwdLabels(
	sessionCwd: string,
	launchCwd: string,
	repoDir: string | null,
): WorkspaceCwdLabels {
	const session = resolveOrientingCwdLabel(sessionCwd, repoDir, launchCwd);
	const sessionResolved = path.resolve(sessionCwd.trim() || launchCwd);
	const launchResolved = path.resolve(launchCwd);
	let shellNote: string | undefined;
	if (sessionResolved !== launchResolved) {
		const shellLabel = resolveOrientingCwdLabel(launchCwd, repoDir, launchCwd);
		shellNote = `shell: ${shellLabel}`;
	}
	return { session, shellNote };
}

/** Actionable one-line summary for collapsed skill diagnostics. */
export function formatSkillDiagnosticsSummary(diagnostics: readonly ResourceDiagnostic[]): string {
	const collisionNames = new Set<string>();
	let warnings = 0;
	let errors = 0;
	for (const d of diagnostics) {
		if (d.type === "collision" && d.collision) {
			collisionNames.add(d.collision.name);
		} else if (d.type === "error") {
			errors++;
		} else {
			warnings++;
		}
	}
	const parts: string[] = [];
	if (collisionNames.size > 0) {
		const names = [...collisionNames].sort((a, b) => a.localeCompare(b));
		const preview = names.slice(0, 3).join(", ");
		const extra = names.length > 3 ? ` +${names.length - 3}` : "";
		const noun = collisionNames.size === 1 ? "duplicate" : "duplicates";
		parts.push(`${collisionNames.size} ${noun} (${preview}${extra})`);
	}
	if (warnings > 0) parts.push(`${warnings} ${warnings === 1 ? "warning" : "warnings"}`);
	if (errors > 0) parts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
	if (parts.length === 0) return `${diagnostics.length} issues`;
	return parts.join(" · ");
}

export function formatExtensionDisplayPath(p: string): string {
	return formatDisplayPath(p)
		.replace(/\/index\.ts$/, "")
		.replace(/\/index\.js$/, "");
}

export function formatContextPath(p: string, cwd: string): string {
	const resolvedCwd = path.resolve(cwd);
	const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(resolvedCwd, p);
	const relativePath = getCwdRelativePath(absolutePath, resolvedCwd);
	if (relativePath !== undefined) {
		return relativePath;
	}
	return formatDisplayPath(absolutePath);
}

export function isPackageSource(sourceInfo?: SourceInfo): boolean {
	const source = sourceInfo?.source ?? "";
	return source.startsWith("npm:") || source.startsWith("git:");
}

export function getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
	const baseDir = sourceInfo?.baseDir;
	if (baseDir && isPackageSource(sourceInfo)) {
		const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
		if (
			relativePath &&
			relativePath !== "." &&
			!relativePath.startsWith("..") &&
			!relativePath.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativePath)
		) {
			return relativePath.replace(/\\/g, "/");
		}
	}

	const source = sourceInfo?.source ?? "";
	const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
	if (npmMatch && source.startsWith("npm:")) {
		return npmMatch[2];
	}

	const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
	if (gitMatch && source.startsWith("git:")) {
		return gitMatch[1];
	}

	return formatDisplayPath(fullPath);
}

export function getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
	const shortPath = getShortPath(resourcePath, sourceInfo);
	const normalizedPath = shortPath.replace(/\\/g, "/");
	const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
	if (segments.length > 0) {
		return segments[segments.length - 1]!;
	}
	return shortPath;
}

export function getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
	const source = sourceInfo?.source ?? "";
	if (source.startsWith("npm:")) {
		return source.slice("npm:".length) || source;
	}

	const gitSource = parseGitUrl(source);
	if (gitSource) {
		return gitSource.path || source;
	}

	return source;
}

export function getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
	if (!isPackageSource(sourceInfo)) {
		return getCompactPathLabel(resourcePath, sourceInfo);
	}

	const sourceLabel = getCompactPackageSourceLabel(sourceInfo);
	if (!sourceLabel) {
		return getCompactPathLabel(resourcePath, sourceInfo);
	}

	const shortPath = getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
	const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
	const parsedPath = path.posix.parse(packagePath);

	if (parsedPath.name === "index") {
		return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
	}

	return `${sourceLabel}:${packagePath}`;
}

export function getCompactDisplayPathSegments(resourcePath: string): string[] {
	return formatDisplayPath(resourcePath)
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== "~");
}

const suffixCountsCache = new WeakMap<Array<{ path: string; segments: string[] }>, Map<string, number>>();

function buildSuffixCounts(allPaths: Array<{ path: string; segments: string[] }>): Map<string, number> {
	const cached = suffixCountsCache.get(allPaths);
	if (cached) return cached;
	const counts = new Map<string, number>();
	for (const { segments } of allPaths) {
		for (let c = 1; c <= segments.length; c += 1) {
			const suf = segments.slice(-c).join("/");
			counts.set(suf, (counts.get(suf) ?? 0) + 1);
		}
	}
	suffixCountsCache.set(allPaths, counts);
	return counts;
}

export function getCompactNonPackageExtensionLabel(
	resourcePath: string,
	index: number,
	allPaths: Array<{ path: string; segments: string[] }>,
): string {
	const segments = allPaths[index]?.segments;
	if (!segments || segments.length === 0) {
		return getCompactPathLabel(resourcePath);
	}

	const suffixCounts = buildSuffixCounts(allPaths);
	for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
		const candidate = segments.slice(-segmentCount).join("/");
		if (suffixCounts.get(candidate) === 1) {
			return candidate;
		}
	}

	return segments.join("/");
}

export function getCompactExtensionLabels(extensions: PathItem[]): string[] {
	const nonPackageExtensions = extensions
		.map((extension) => {
			const segments = getCompactDisplayPathSegments(extension.path);
			const lastSegment = segments[segments.length - 1];
			if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
				segments.pop();
			}
			return {
				path: extension.path,
				sourceInfo: extension.sourceInfo,
				segments,
			};
		})
		.filter((extension) => !isPackageSource(extension.sourceInfo));

	const pathToNonPackageIndex = new Map<string, number>();
	for (let i = 0; i < nonPackageExtensions.length; i++) {
		pathToNonPackageIndex.set(nonPackageExtensions[i]!.path, i);
	}

	return extensions.map((extension) => {
		if (isPackageSource(extension.sourceInfo)) {
			return getCompactExtensionLabel(extension.path, extension.sourceInfo);
		}

		const nonPackageIndex = pathToNonPackageIndex.get(extension.path);
		if (nonPackageIndex === undefined) {
			return getCompactPathLabel(extension.path, extension.sourceInfo);
		}

		return getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
	});
}

export function getDisplaySourceInfo(sourceInfo?: SourceInfo): {
	label: string;
	scopeLabel?: string;
	color: "accent" | "muted";
} {
	const source = sourceInfo?.source ?? "local";
	const scope = sourceInfo?.scope ?? "project";
	if (source === "local") {
		if (scope === "user") {
			return { label: "user", color: "muted" };
		}
		if (scope === "project") {
			return { label: "project", color: "muted" };
		}
		if (scope === "temporary") {
			return { label: "path", scopeLabel: "temp", color: "muted" };
		}
		return { label: "path", color: "muted" };
	}

	if (source === "cli") {
		return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
	}

	let scopeLabel: string | undefined;
	if (scope === "user") scopeLabel = "user";
	else if (scope === "project") scopeLabel = "project";
	else if (scope === "temporary") scopeLabel = "temp";
	return { label: source, scopeLabel, color: "accent" };
}

export function getScopeGroup(sourceInfo?: SourceInfo): ScopeName {
	const source = sourceInfo?.source ?? "local";
	const scope = sourceInfo?.scope ?? "project";
	if (source === "cli" || scope === "temporary") return "path";
	if (scope === "user") return "user";
	if (scope === "project") return "project";
	return "path";
}

export type ScopeName = "user" | "project" | "path";
export interface PathItem {
	path: string;
	sourceInfo?: SourceInfo;
}
export interface ScopeGroup {
	scope: ScopeName;
	paths: PathItem[];
	packages: Map<string, PathItem[]>;
}

export function buildScopeGroups(items: PathItem[]): ScopeGroup[] {
	const groups: Record<ScopeName, ScopeGroup> = {
		user: { scope: "user", paths: [], packages: new Map() },
		project: { scope: "project", paths: [], packages: new Map() },
		path: { scope: "path", paths: [], packages: new Map() },
	};

	for (const item of items) {
		const groupKey = getScopeGroup(item.sourceInfo);
		const group = groups[groupKey];
		const source = item.sourceInfo?.source ?? "local";

		if (isPackageSource(item.sourceInfo)) {
			const list = group.packages.get(source) ?? [];
			list.push(item);
			group.packages.set(source, list);
		} else {
			group.paths.push(item);
		}
	}

	return [groups.project, groups.user, groups.path].filter(
		(group) => group.paths.length > 0 || group.packages.size > 0,
	);
}

export function formatScopeGroups(
	groups: ScopeGroup[],
	options: {
		formatPath: (item: PathItem) => string;
		formatPackagePath: (item: PathItem, source: string) => string;
	},
): string {
	const lines: string[] = [];

	for (const group of groups) {
		lines.push(`  ${theme.fg("accent", group.scope)}`);

		const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
		for (const item of sortedPaths) {
			lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
		}

		const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
		for (const [source, items] of sortedPackages) {
			lines.push(`    ${theme.fg("mdLink", source)}`);
			const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPackagePaths) {
				lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
			}
		}
	}

	return lines.join("\n");
}

export function findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
	const exact = sourceInfos.get(p);
	if (exact) return exact;

	let current = p;
	while (current.includes("/")) {
		current = current.substring(0, current.lastIndexOf("/"));
		const parent = sourceInfos.get(current);
		if (parent) return parent;
	}

	return undefined;
}

export function formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
	if (sourceInfo) {
		const shortPath = getShortPath(p, sourceInfo);
		const { label, scopeLabel } = getDisplaySourceInfo(sourceInfo);
		const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
		return `${labelText} ${shortPath}`;
	}
	return formatDisplayPath(p);
}

export function formatDiagnostics(
	diagnostics: readonly ResourceDiagnostic[],
	sourceInfos: Map<string, SourceInfo>,
): string {
	const lines: string[] = [];
	const sourceCache = new Map<string, SourceInfo | undefined>();
	const cachedFindSource = (p: string): SourceInfo | undefined => {
		if (sourceCache.has(p)) return sourceCache.get(p);
		const result = findSourceInfoForPath(p, sourceInfos);
		sourceCache.set(p, result);
		return result;
	};

	const collisions = new Map<string, ResourceDiagnostic[]>();
	const otherDiagnostics: ResourceDiagnostic[] = [];

	for (const d of diagnostics) {
		if (d.type === "collision" && d.collision) {
			const list = collisions.get(d.collision.name) ?? [];
			list.push(d);
			collisions.set(d.collision.name, list);
		} else {
			otherDiagnostics.push(d);
		}
	}

	if (collisions.size > 0) {
		lines.push(
			theme.fg(
				"dim",
				`  Highest-precedence source wins; ${theme.fg("success", "✓")} kept, ${theme.fg("warning", "✗")} ignored.`,
			),
		);
	}

	for (const [name, collisionList] of collisions) {
		const first = collisionList[0]?.collision;
		if (!first) continue;
		const precedence =
			first.winnerSource && first.loserSource ? ` (${first.winnerSource} > ${first.loserSource})` : "";
		lines.push(theme.fg("warning", `  "${name}" collision${precedence}:`));
		lines.push(
			theme.fg(
				"dim",
				`    ${theme.fg("success", "✓")} ${formatPathWithSource(first.winnerPath, cachedFindSource(first.winnerPath))}`,
			),
		);
		for (const d of collisionList) {
			if (d.collision) {
				lines.push(
					theme.fg(
						"dim",
						`    ${theme.fg("warning", "✗")} ${formatPathWithSource(d.collision.loserPath, cachedFindSource(d.collision.loserPath))} (skipped)`,
					),
				);
			}
		}
	}

	for (const d of otherDiagnostics) {
		if (d.path) {
			const formattedPath = formatPathWithSource(d.path, cachedFindSource(d.path));
			lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
			lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
		} else {
			lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
		}
	}

	return lines.join("\n");
}
