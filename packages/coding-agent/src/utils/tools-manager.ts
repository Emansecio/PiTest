import chalk from "chalk";
import { type SpawnSyncReturns, spawnSync } from "child_process";
import { createHash } from "crypto";
import {
	chmodSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { arch, platform } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { APP_NAME, getAgentDir, getBinDir } from "../config.ts";
import { isOfflineMode, isTruthyEnvFlag } from "./env-flags.ts";

const TOOLS_DIR = getBinDir();
const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

interface ToolConfig {
	name: string;
	repo: string; // GitHub repo (e.g., "sharkdp/fd")
	binaryName: string; // Name of the binary inside the archive
	systemBinaryNames?: string[]; // Alternative system command names to try before downloading
	tagPrefix: string; // Prefix for tags (e.g., "v" for v1.0.0, "" for 1.0.0)
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				if (architecture === "arm64") {
					return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
				}
				return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
};

// Check if a command exists in PATH by trying to run it
function commandExists(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
		// Check for ENOENT error (command not found)
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// System-PATH lookup cache
//
// A tool that lives in PATH but not in TOOLS_DIR used to cost one spawnSync
// per boot per tool (`fd --version` / `rg --version`, ~50-150ms each on
// Windows). We resolve the command's binary once via `where`/`which`, then
// cache (command, binaryPath, mtime+size, PATH fingerprint) on disk in
// <agentDir>/tool-path-cache.json. Validation on later boots is one statSync.
//
// Invalidation is automatic:
//   - the recorded binary disappearing or changing (mtime/size) → re-detect;
//   - PATH / PATHEXT changing (a different install could shadow) → re-detect.
// The cache stores the bare command name, so actual spawns still resolve via
// PATH at call time — a newer binary earlier in an unchanged PATH would be
// picked up by the OS, not pinned by us.
//
// Escape hatch: PIT_NO_TOOL_PATH_CACHE=1 disables both read and write.
// ---------------------------------------------------------------------------

const TOOL_PATH_CACHE_FILE = "tool-path-cache.json";
const TOOL_PATH_CACHE_SCHEMA = 1;

interface ToolPathCacheEntry {
	command: string;
	binaryPath: string;
	mtimeMs: number;
	size: number;
	pathKey: string;
}

interface ToolPathCacheFile {
	schema: number;
	entries: Record<string, ToolPathCacheEntry>;
}

function toolPathCachePath(): string {
	return join(getAgentDir(), TOOL_PATH_CACHE_FILE);
}

function currentPathKey(): string {
	return createHash("sha1")
		.update(`${process.env.PATH ?? ""}\0${process.env.PATHEXT ?? ""}`)
		.digest("hex");
}

function readToolPathCacheFile(): Record<string, ToolPathCacheEntry> {
	try {
		const file = JSON.parse(readFileSync(toolPathCachePath(), "utf8")) as Partial<ToolPathCacheFile>;
		if (file.schema === TOOL_PATH_CACHE_SCHEMA && file.entries && typeof file.entries === "object") {
			return file.entries;
		}
	} catch {
		// Missing/corrupt cache — treated as empty.
	}
	return {};
}

/**
 * Return the cached command name when the recorded binary is unchanged and the
 * PATH fingerprint still matches; null on any miss.
 */
export function readCachedSystemCommand(command: string): string | null {
	if (isTruthyEnvFlag(process.env.PIT_NO_TOOL_PATH_CACHE)) {
		return null;
	}
	const entry = readToolPathCacheFile()[command];
	if (
		!entry ||
		typeof entry.binaryPath !== "string" ||
		entry.command !== command ||
		entry.pathKey !== currentPathKey()
	) {
		return null;
	}
	try {
		const stats = statSync(entry.binaryPath);
		if (stats.isFile() && stats.mtimeMs === entry.mtimeMs && stats.size === entry.size) {
			return entry.command;
		}
	} catch {
		// Binary gone — fall through to live detection.
	}
	return null;
}

/** Record a verified PATH command → binary mapping. Best-effort. */
export function writeCachedSystemCommand(command: string, binaryPath: string): void {
	if (isTruthyEnvFlag(process.env.PIT_NO_TOOL_PATH_CACHE)) {
		return;
	}
	try {
		const stats = statSync(binaryPath);
		if (!stats.isFile()) {
			return;
		}
		const entries = readToolPathCacheFile();
		entries[command] = {
			command,
			binaryPath,
			mtimeMs: stats.mtimeMs,
			size: stats.size,
			pathKey: currentPathKey(),
		};
		const file: ToolPathCacheFile = { schema: TOOL_PATH_CACHE_SCHEMA, entries };
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(toolPathCachePath(), `${JSON.stringify(file, null, "\t")}\n`, "utf8");
	} catch {
		// Best-effort cache — lookups just stay on the spawn path.
	}
}

function getWindowsWhereCommand(): string {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (systemRoot) {
		const systemWhere = join(systemRoot, "System32", "where.exe");
		if (existsSync(systemWhere)) {
			return systemWhere;
		}
	}
	return "where.exe";
}

/**
 * Resolve `cmd` to the full path of its PATH binary via `where`/`which`.
 * Returns the path, null when the command is not in PATH, or undefined when
 * the finder itself is unavailable (caller falls back to the spawn probe).
 */
function resolveCommandBinary(cmd: string): string | null | undefined {
	const finder = platform() === "win32" ? getWindowsWhereCommand() : "which";
	try {
		const result = spawnSync(finder, [cmd], { stdio: "pipe", encoding: "utf8" });
		if (result.error) {
			return undefined;
		}
		if (result.status !== 0) {
			return null;
		}
		const first = (result.stdout ?? "")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean);
		return first || null;
	} catch {
		return undefined;
	}
}

// Get the path to a tool (system-wide or in our tools dir)
export function getToolPath(tool: "fd" | "rg"): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first
	const localPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
	if (existsSync(localPath)) {
		return localPath;
	}

	// Check system PATH. Disk-cache fast path first (one statSync), then a
	// where/which resolution that both detects the command and records the
	// binary for the next boot's cache hit.
	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		if (readCachedSystemCommand(systemBinaryName)) {
			return systemBinaryName;
		}
	}
	for (const systemBinaryName of systemBinaryNames) {
		const binaryPath = resolveCommandBinary(systemBinaryName);
		if (binaryPath) {
			writeCachedSystemCommand(systemBinaryName, binaryPath);
			return systemBinaryName;
		}
		// undefined = where/which unavailable → legacy spawn probe (uncached).
		if (binaryPath === undefined && commandExists(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
}

// Fetch latest release version from GitHub
async function getLatestVersion(repo: string): Promise<string> {
	const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
		headers: { "User-Agent": `${APP_NAME}-coding-agent` },
		signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`GitHub API error: ${response.status}`);
	}

	const data = (await response.json()) as { tag_name: string };
	return data.tag_name.replace(/^v/, "");
}

// Download a file from URL
async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`Failed to download: ${response.status}`);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	const fileStream = createWriteStream(dest);
	await pipeline(Readable.fromWeb(response.body as any), fileStream);
}

function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;

		const entries = readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === binaryFileName) {
				return fullPath;
			}
			if (entry.isDirectory()) {
				stack.push(fullPath);
			}
		}
	}

	return null;
}

function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
	if (result.error?.message) {
		return result.error.message;
	}
	const stderr = result.stderr?.toString().trim();
	if (stderr) {
		return stderr;
	}
	const stdout = result.stdout?.toString().trim();
	if (stdout) {
		return stdout;
	}
	return `exit status ${result.status ?? "unknown"}`;
}

function runExtractionCommand(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { stdio: "pipe" });
	if (!result.error && result.status === 0) {
		return null;
	}
	return `${command}: ${formatSpawnFailure(result)}`;
}

function extractTarGzArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failure = runExtractionCommand("tar", ["xzf", archivePath, "-C", extractDir]);
	if (failure) {
		throw new Error(`Failed to extract ${assetName}: ${failure}`);
	}
}

function getWindowsTarCommand(): string {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (systemRoot) {
		const systemTar = join(systemRoot, "System32", "tar.exe");
		if (existsSync(systemTar)) {
			return systemTar;
		}
	}
	return "tar.exe";
}

function extractZipArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failures: string[] = [];

	if (platform() === "win32") {
		// Windows ships bsdtar as tar.exe, which supports zip files. Prefer the
		// System32 binary over Git Bash's GNU tar, which does not handle zip archives.
		const tarFailure = runExtractionCommand(getWindowsTarCommand(), ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);

		const script =
			"& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
		const powershellFailure = runExtractionCommand("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
			archivePath,
			extractDir,
		]);
		if (!powershellFailure) return;
		failures.push(powershellFailure);
	} else {
		const unzipFailure = runExtractionCommand("unzip", ["-q", archivePath, "-d", extractDir]);
		if (!unzipFailure) return;
		failures.push(unzipFailure);

		const tarFailure = runExtractionCommand("tar", ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);
	}

	throw new Error(`Failed to extract ${assetName}: ${failures.join("; ")}`);
}

// Download and install a tool
async function downloadTool(tool: "fd" | "rg"): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();

	// Get latest version
	let version = await getLatestVersion(config.repo);
	if (tool === "fd" && plat === "darwin" && architecture === "x64") {
		version = "10.3.0";
	}

	// Get asset name for this platform
	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	// Create tools directory
	mkdirSync(TOOLS_DIR, { recursive: true });

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

	// Use a unique per-call suffix for the archive and the staged binary. fd and rg
	// downloads (and even two concurrent calls for the same tool before the cache is
	// populated) can run at once during startup; sharing a fixed archivePath/binaryPath
	// corrupts the archive bytes and races renameSync onto the same destination.
	const uniqueSuffix = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
	const archivePath = join(TOOLS_DIR, `${assetName}.${uniqueSuffix}.part`);
	const stagedBinaryPath = join(TOOLS_DIR, `${config.binaryName}${binaryExt}.${uniqueSuffix}.staged`);

	// Download. If downloadFile throws (network abort, ECONNRESET mid-stream), the
	// pipeline destroys the write stream but leaves the partial .part file at
	// archivePath on disk. This happens before the try/finally below is entered, so
	// remove the orphaned archive here to prevent failed downloads from accumulating
	// <asset>.<suffix>.part files in the tools dir.
	try {
		await downloadFile(downloadUrl, archivePath);
	} catch (e) {
		rmSync(archivePath, { force: true });
		throw e;
	}

	// Extract into a unique temp directory. fd and rg downloads can run concurrently
	// during startup, so sharing a fixed directory causes races.
	const extractDir = join(TOOLS_DIR, `extract_tmp_${config.binaryName}_${uniqueSuffix}`);
	mkdirSync(extractDir, { recursive: true });

	try {
		if (assetName.endsWith(".tar.gz")) {
			extractTarGzArchive(archivePath, extractDir, assetName);
		} else if (assetName.endsWith(".zip")) {
			extractZipArchive(archivePath, extractDir, assetName);
		} else {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		// Find the binary in extracted files. Some archives contain files directly
		// at root, others nest under a versioned subdirectory.
		const binaryFileName = config.binaryName + binaryExt;
		const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
		const extractedBinaryCandidates = [join(extractedDir, binaryFileName), join(extractDir, binaryFileName)];
		let extractedBinary = extractedBinaryCandidates.find((candidate) => existsSync(candidate));

		if (!extractedBinary) {
			extractedBinary = findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
		}

		if (!extractedBinary) {
			throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
		}

		// Stage the extracted binary under a unique name, then atomically rename it
		// onto the shared binaryPath. This keeps the final publish a single atomic
		// rename instead of writing a shared destination mid-extraction, so two
		// concurrent downloads for the same tool can't observe a half-written binary.
		renameSync(extractedBinary, stagedBinaryPath);

		// Make executable (Unix only) on the staged copy before publishing.
		if (plat !== "win32") {
			chmodSync(stagedBinaryPath, 0o755);
		}

		renameSync(stagedBinaryPath, binaryPath);
	} finally {
		// Cleanup
		rmSync(archivePath, { force: true });
		rmSync(stagedBinaryPath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
}

// Termux package names for tools
const TERMUX_PACKAGES: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
};

const ensureToolCache = new Map<string, string>();
// In-flight downloads keyed by tool. Concurrent ensureTool() calls for the same tool
// (e.g. interactive startup priming fd/rg while a find/grep tool independently calls
// ensureTool before the cache is populated) must share a single download instead of
// racing two downloadTool() runs onto the same archive/binary paths.
const inflightDownloads = new Map<string, Promise<string | undefined>>();

// Ensure a tool is available, downloading if necessary
// Returns the path to the tool, or null if unavailable
export async function ensureTool(tool: "fd" | "rg", silent: boolean = false): Promise<string | undefined> {
	const cached = ensureToolCache.get(tool);
	if (cached) return cached;

	const existingPath = getToolPath(tool);
	if (existingPath) {
		ensureToolCache.set(tool, existingPath);
		return existingPath;
	}

	// If a download for this tool is already running, await it instead of starting another.
	const inflight = inflightDownloads.get(tool);
	if (inflight) return inflight;

	const config = TOOLS[tool];
	if (!config) return undefined;

	if (isOfflineMode()) {
		if (!silent) {
			console.log(chalk.yellow(`${config.name} not found. Offline mode enabled, skipping download.`));
		}
		return undefined;
	}

	// On Android/Termux, Linux binaries don't work due to Bionic libc incompatibility.
	// Users must install via pkg.
	if (platform() === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		if (!silent) {
			console.log(chalk.yellow(`${config.name} not found. Install with: pkg install ${pkgName}`));
		}
		return undefined;
	}

	// Tool not found - download it
	if (!silent) {
		console.log(chalk.dim(`${config.name} not found. Downloading...`));
	}

	const downloadPromise = (async (): Promise<string | undefined> => {
		try {
			const path = await downloadTool(tool);
			if (!silent) {
				console.log(chalk.dim(`${config.name} installed to ${path}`));
			}
			ensureToolCache.set(tool, path);
			return path;
		} catch (e) {
			if (!silent) {
				console.log(chalk.yellow(`Failed to download ${config.name}: ${e instanceof Error ? e.message : e}`));
			}
			return undefined;
		} finally {
			inflightDownloads.delete(tool);
		}
	})();

	inflightDownloads.set(tool, downloadPromise);
	return downloadPromise;
}
