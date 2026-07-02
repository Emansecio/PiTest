import { type ExecFileException, execFile, spawnSync } from "child_process";
import { existsSync, type FSWatcher, readFileSync, statSync, unwatchFile, watchFile } from "fs";
import { dirname, join, resolve } from "path";
import { closeWatcher, FS_WATCH_RETRY_DELAY_MS, watchWithErrorHandler } from "../utils/fs-watch.ts";

type GitPaths = {
	repoDir: string;
	commonGitDir: string;
	headPath: string;
};

/**
 * Find git metadata paths by walking up from cwd.
 * Handles both regular git repos (.git is a directory) and worktrees (.git is a file).
 */
function findGitPaths(cwd: string): GitPaths | null {
	let dir = cwd;
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isFile()) {
					const content = readFileSync(gitPath, "utf8").trim();
					if (content.startsWith("gitdir: ")) {
						const gitDir = resolve(dir, content.slice(8).trim());
						const headPath = join(gitDir, "HEAD");
						if (!existsSync(headPath)) return null;
						const commonDirPath = join(gitDir, "commondir");
						const commonGitDir = existsSync(commonDirPath)
							? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
							: gitDir;
						return { repoDir: dir, commonGitDir, headPath };
					}
				} else if (stat.isDirectory()) {
					const headPath = join(gitPath, "HEAD");
					if (!existsSync(headPath)) return null;
					return { repoDir: dir, commonGitDir: gitPath, headPath };
				}
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Ask git for the current branch. Returns null on detached HEAD or if git is unavailable. */
function resolveBranchWithGitSync(repoDir: string): string | null {
	const result = spawnSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd: repoDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const branch = result.status === 0 ? result.stdout.trim() : "";
	return branch || null;
}

/** Working-tree delta vs HEAD. null = not in a git repo. */
export type GitDiffStats = {
	/** Paths with any change (modified/staged/untracked/deleted). */
	files: number;
	insertions: number;
	deletions: number;
};

/** Parse `git diff --numstat HEAD` output into insertion/deletion totals. */
export function parseGitDiffNumstat(stdout: string): { insertions: number; deletions: number } {
	let insertions = 0;
	let deletions = 0;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = trimmed.split("\t");
		if (parts.length < 3) continue;
		const add = parts[0];
		const del = parts[1];
		if (add === "-" || del === "-") continue;
		const addNum = Number.parseInt(add ?? "", 10);
		const delNum = Number.parseInt(del ?? "", 10);
		if (Number.isFinite(addNum)) insertions += addNum;
		if (Number.isFinite(delNum)) deletions += delNum;
	}
	return { insertions, deletions };
}

/** Count non-empty lines from `git status --porcelain`. */
export function parseGitStatusPorcelainFileCount(stdout: string): number {
	return stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

function gitDiffStatsEqual(a: GitDiffStats | null | undefined, b: GitDiffStats | null | undefined): boolean {
	if (a === b) return true;
	if (a === null || a === undefined || b === null || b === undefined) return false;
	return a.files === b.files && a.insertions === b.insertions && a.deletions === b.deletions;
}

/** Ask git for the current branch asynchronously. Returns null on detached HEAD or if git is unavailable. */
function resolveBranchWithGitAsync(repoDir: string): Promise<string | null> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
			{
				cwd: repoDir,
				encoding: "utf8",
			},
			(error: ExecFileException | null, stdout: string) => {
				if (error) {
					resolvePromise(null);
					return;
				}
				const branch = stdout.trim();
				resolvePromise(branch || null);
			},
		);
	});
}

/**
 * Provides git branch and extension statuses - data not otherwise accessible to extensions.
 * Token stats, model info available via ctx.sessionManager and ctx.model.
 */
export class FooterDataProvider {
	private cwd: string;
	private static readonly WATCH_DEBOUNCE_MS = 500;
	private static readonly DIFF_POLL_MS = 5000;

	private extensionStatuses = new Map<string, string>();
	private statusVersion = 0;
	private cachedBranch: string | null | undefined = undefined;
	private cachedDiffStats: GitDiffStats | null | undefined = undefined;
	private diffStatsVersion = 0;
	private gitPaths: GitPaths | null | undefined = undefined;
	private headWatcher: FSWatcher | null = null;
	private indexWatcher: FSWatcher | null = null;
	private reftableWatcher: FSWatcher | null = null;
	private reftableTablesListWatcher: FSWatcher | null = null;
	private reftableTablesListPath: string | null = null;
	private branchChangeCallbacks = new Set<() => void>();
	private workingTreeChangeCallbacks = new Set<() => void>();
	private availableProviderCount = 0;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private diffRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	private diffPollTimer: ReturnType<typeof setInterval> | null = null;
	private gitWatcherRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshInFlight = false;
	private refreshPending = false;
	private diffRefreshInFlight = false;
	private diffRefreshPending = false;
	private disposed = false;
	private generation = 0;

	constructor(cwd: string) {
		this.cwd = cwd;
		this.gitPaths = findGitPaths(cwd);
		this.setupGitWatcher();
		this.startDiffPoll();
		void this.refreshGitDiffStatsAsync();
	}

	/**
	 * Absolute path of the git repository root (the directory containing `.git`),
	 * or null when cwd is not inside a repo. Surfaced so the footer can render the
	 * cwd relative to the repo root instead of as a long absolute path.
	 */
	getRepoDir(): string | null {
		return this.gitPaths?.repoDir ?? null;
	}

	/** Current git branch, null if not in repo, "detached" if detached HEAD */
	getGitBranch(): string | null {
		if (this.cachedBranch === undefined) {
			this.cachedBranch = this.resolveGitBranchSync();
		}
		return this.cachedBranch;
	}

	/** Extension status texts set via ctx.ui.setStatus() */
	getExtensionStatuses(): ReadonlyMap<string, string> {
		return this.extensionStatuses;
	}

	/** Monotonically increasing counter; bumped on every status mutation. */
	getStatusVersion(): number {
		return this.statusVersion;
	}

	/** Subscribe to git branch changes. Returns unsubscribe function. */
	onBranchChange(callback: () => void): () => void {
		this.branchChangeCallbacks.add(callback);
		return () => this.branchChangeCallbacks.delete(callback);
	}

	/** Working-tree diff stats, null when cwd is outside a git repo. */
	getGitDiffStats(): GitDiffStats | null {
		if (!this.gitPaths) return null;
		if (this.cachedDiffStats === undefined) {
			this.cachedDiffStats = this.resolveGitDiffStatsSync();
		}
		return this.cachedDiffStats;
	}

	/** Monotonic counter bumped when cached diff stats change. */
	getGitDiffVersion(): number {
		return this.diffStatsVersion;
	}

	/** Subscribe to working-tree diff stat changes. Returns unsubscribe function. */
	onWorkingTreeChange(callback: () => void): () => void {
		this.workingTreeChangeCallbacks.add(callback);
		return () => this.workingTreeChangeCallbacks.delete(callback);
	}

	/** Debounced refresh of working-tree diff stats (safe from tool callbacks). */
	scheduleWorkingTreeRefresh(): void {
		this.scheduleDiffRefresh();
	}

	/** Internal: set extension status */
	setExtensionStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.extensionStatuses.delete(key);
		} else {
			this.extensionStatuses.set(key, text);
		}
		this.statusVersion++;
	}

	/** Internal: clear extension statuses */
	clearExtensionStatuses(): void {
		this.extensionStatuses.clear();
		this.statusVersion++;
	}

	/** Number of unique providers with available models (for footer display) */
	getAvailableProviderCount(): number {
		return this.availableProviderCount;
	}

	/** Internal: update available provider count */
	setAvailableProviderCount(count: number): void {
		this.availableProviderCount = count;
	}

	setCwd(cwd: string): void {
		if (this.cwd === cwd) {
			return;
		}

		this.cwd = cwd;
		this.generation++;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearGitWatchers();
		this.cachedBranch = undefined;
		this.cachedDiffStats = undefined;
		this.gitPaths = findGitPaths(cwd);
		this.setupGitWatcher();
		this.startDiffPoll();
		this.notifyBranchChange();
		void this.refreshGitDiffStatsAsync();
	}

	/** Internal: cleanup */
	dispose(): void {
		this.disposed = true;
		this.generation++;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		if (this.diffRefreshTimer) {
			clearTimeout(this.diffRefreshTimer);
			this.diffRefreshTimer = null;
		}
		if (this.diffPollTimer) {
			clearInterval(this.diffPollTimer);
			this.diffPollTimer = null;
		}
		this.clearGitWatchers();
		this.branchChangeCallbacks.clear();
		this.workingTreeChangeCallbacks.clear();
	}

	private notifyBranchChange(): void {
		for (const cb of this.branchChangeCallbacks) cb();
	}

	private notifyWorkingTreeChange(): void {
		for (const cb of this.workingTreeChangeCallbacks) cb();
	}

	private scheduleRefresh(): void {
		if (this.disposed || this.refreshTimer) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.refreshGitBranchAsync();
		}, FooterDataProvider.WATCH_DEBOUNCE_MS);
	}

	private async refreshGitBranchAsync(): Promise<void> {
		if (this.disposed) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}

		this.refreshInFlight = true;
		const generationAtStart = this.generation;
		try {
			const nextBranch = await this.resolveGitBranchAsync();
			if (this.disposed) return;
			// If cwd changed (or we were disposed) while the refresh was in flight,
			// the resolved branch belongs to the old repo — discard it.
			if (this.generation !== generationAtStart) return;
			if (this.cachedBranch !== undefined && this.cachedBranch !== nextBranch) {
				this.cachedBranch = nextBranch;
				this.notifyBranchChange();
				return;
			}
			this.cachedBranch = nextBranch;
		} finally {
			this.refreshInFlight = false;
			if (this.refreshPending && !this.disposed) {
				this.refreshPending = false;
				this.scheduleRefresh();
			}
		}
	}

	private resolveGitBranchSync(): string | null {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16);
				return branch === ".invalid" ? (resolveBranchWithGitSync(this.gitPaths.repoDir) ?? "detached") : branch;
			}
			return "detached";
		} catch {
			return null;
		}
	}

	private async resolveGitBranchAsync(): Promise<string | null> {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16);
				return branch === ".invalid"
					? ((await resolveBranchWithGitAsync(this.gitPaths.repoDir)) ?? "detached")
					: branch;
			}
			return "detached";
		} catch {
			return null;
		}
	}

	private resolveGitDiffStatsSync(): GitDiffStats | null {
		if (!this.gitPaths) return null;
		const repoDir = this.gitPaths.repoDir;
		const numstat = spawnSync("git", ["--no-optional-locks", "diff", "--numstat", "HEAD"], {
			cwd: repoDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const porcelain = spawnSync("git", ["--no-optional-locks", "status", "--porcelain", "-u", "normal"], {
			cwd: repoDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (numstat.status !== 0 && porcelain.status !== 0) {
			return null;
		}
		const { insertions, deletions } =
			numstat.status === 0 ? parseGitDiffNumstat(numstat.stdout) : { insertions: 0, deletions: 0 };
		const files = porcelain.status === 0 ? parseGitStatusPorcelainFileCount(porcelain.stdout) : 0;
		return { files, insertions, deletions };
	}

	private resolveGitDiffStatsAsync(repoDir: string): Promise<GitDiffStats | null> {
		return new Promise((resolvePromise) => {
			execFile(
				"git",
				["--no-optional-locks", "diff", "--numstat", "HEAD"],
				{ cwd: repoDir, encoding: "utf8" },
				(numstatError: ExecFileException | null, numstatStdout: string) => {
					execFile(
						"git",
						["--no-optional-locks", "status", "--porcelain", "-u", "normal"],
						{ cwd: repoDir, encoding: "utf8" },
						(porcelainError: ExecFileException | null, porcelainStdout: string) => {
							if (numstatError && porcelainError) {
								resolvePromise(null);
								return;
							}
							const { insertions, deletions } = numstatError
								? { insertions: 0, deletions: 0 }
								: parseGitDiffNumstat(numstatStdout);
							const files = porcelainError ? 0 : parseGitStatusPorcelainFileCount(porcelainStdout);
							resolvePromise({ files, insertions, deletions });
						},
					);
				},
			);
		});
	}

	private scheduleDiffRefresh(): void {
		if (this.disposed || this.diffRefreshTimer) return;
		if (this.diffRefreshInFlight) {
			this.diffRefreshPending = true;
			return;
		}
		this.diffRefreshTimer = setTimeout(() => {
			this.diffRefreshTimer = null;
			void this.refreshGitDiffStatsAsync();
		}, FooterDataProvider.WATCH_DEBOUNCE_MS);
	}

	private async refreshGitDiffStatsAsync(): Promise<void> {
		if (this.disposed || !this.gitPaths) return;
		if (this.diffRefreshInFlight) {
			this.diffRefreshPending = true;
			return;
		}

		this.diffRefreshInFlight = true;
		const generationAtStart = this.generation;
		const repoDir = this.gitPaths.repoDir;
		try {
			const nextStats = await this.resolveGitDiffStatsAsync(repoDir);
			if (this.disposed) return;
			if (this.generation !== generationAtStart) return;
			const prevStats = this.cachedDiffStats;
			this.cachedDiffStats = nextStats;
			if (!gitDiffStatsEqual(prevStats, nextStats)) {
				this.diffStatsVersion++;
				this.notifyWorkingTreeChange();
			}
		} finally {
			this.diffRefreshInFlight = false;
			if (this.diffRefreshPending && !this.disposed) {
				this.diffRefreshPending = false;
				this.scheduleDiffRefresh();
			}
		}
	}

	private startDiffPoll(): void {
		if (this.diffPollTimer) {
			clearInterval(this.diffPollTimer);
			this.diffPollTimer = null;
		}
		if (this.disposed || !this.gitPaths) return;
		this.diffPollTimer = setInterval(() => {
			if (this.disposed) return;
			this.scheduleDiffRefresh();
		}, FooterDataProvider.DIFF_POLL_MS);
	}

	private clearGitWatchers(): void {
		closeWatcher(this.headWatcher);
		this.headWatcher = null;
		closeWatcher(this.indexWatcher);
		this.indexWatcher = null;
		closeWatcher(this.reftableWatcher);
		this.reftableWatcher = null;
		closeWatcher(this.reftableTablesListWatcher);
		this.reftableTablesListWatcher = null;
		if (this.reftableTablesListPath) {
			unwatchFile(this.reftableTablesListPath);
			this.reftableTablesListPath = null;
		}
		if (this.gitWatcherRetryTimer) {
			clearTimeout(this.gitWatcherRetryTimer);
			this.gitWatcherRetryTimer = null;
		}
	}

	private scheduleGitWatcherRetry(): void {
		if (this.disposed || this.gitWatcherRetryTimer) {
			return;
		}

		this.gitWatcherRetryTimer = setTimeout(() => {
			this.gitWatcherRetryTimer = null;
			this.setupGitWatcher();
		}, FS_WATCH_RETRY_DELAY_MS);
	}

	private handleGitWatcherError(): void {
		this.clearGitWatchers();
		this.scheduleGitWatcherRetry();
	}

	private setupGitWatcher(): void {
		this.clearGitWatchers();
		if (!this.gitPaths) return;

		// Watch the directory containing HEAD, not HEAD itself.
		// Git uses atomic writes (write temp, rename over HEAD), which changes the inode.
		// fs.watch on a file stops working after the inode changes.
		this.headWatcher = watchWithErrorHandler(
			dirname(this.gitPaths.headPath),
			(_eventType, filename) => {
				if (!filename || filename === "HEAD") {
					this.scheduleRefresh();
				}
			},
			() => this.handleGitWatcherError(),
		);
		if (!this.headWatcher) {
			return;
		}

		const indexPath = join(this.gitPaths.commonGitDir, "index");
		if (existsSync(indexPath)) {
			this.indexWatcher = watchWithErrorHandler(
				indexPath,
				() => {
					this.scheduleDiffRefresh();
				},
				() => this.handleGitWatcherError(),
			);
		}

		// In reftable repos, branch switches update files in the reftable directory
		// instead of HEAD. Watch it separately so the footer picks up those changes.
		const reftableDir = join(this.gitPaths.commonGitDir, "reftable");
		if (existsSync(reftableDir)) {
			this.reftableWatcher = watchWithErrorHandler(
				reftableDir,
				() => {
					this.scheduleRefresh();
				},
				() => this.handleGitWatcherError(),
			);
			if (!this.reftableWatcher) {
				return;
			}

			const tablesListPath = join(reftableDir, "tables.list");
			if (existsSync(tablesListPath)) {
				this.reftableTablesListPath = tablesListPath;
				this.reftableTablesListWatcher = watchWithErrorHandler(
					tablesListPath,
					() => {
						this.scheduleRefresh();
					},
					() => this.handleGitWatcherError(),
				);
				if (!this.reftableTablesListWatcher) {
					return;
				}
				watchFile(tablesListPath, { interval: 250 }, (current, previous) => {
					if (
						current.mtimeMs !== previous.mtimeMs ||
						current.ctimeMs !== previous.ctimeMs ||
						current.size !== previous.size
					) {
						this.scheduleRefresh();
					}
				});
			}
		}
	}
}

/** Read-only view for extensions - excludes setExtensionStatus, setAvailableProviderCount and dispose */
export type ReadonlyFooterDataProvider = Pick<
	FooterDataProvider,
	| "getGitBranch"
	| "getGitDiffStats"
	| "getGitDiffVersion"
	| "getRepoDir"
	| "getExtensionStatuses"
	| "getStatusVersion"
	| "getAvailableProviderCount"
	| "onBranchChange"
	| "onWorkingTreeChange"
>;
