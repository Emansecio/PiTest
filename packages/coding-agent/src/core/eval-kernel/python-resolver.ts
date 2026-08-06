import { accessSync, constants, existsSync } from "node:fs";
import { posix, win32 } from "node:path";

export type PythonCandidateSource = "override" | "virtual-env" | "local-.venv" | "local-venv" | "path";

export interface ResolvedPython {
	command: string;
	source: PythonCandidateSource;
}

export interface PythonResolverOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	isFile?: (path: string) => boolean;
	isExecutable?: (path: string) => boolean;
}

interface Attempt {
	source: PythonCandidateSource;
	candidate: string;
	reason: string;
}

const SOURCE_LABELS: Record<PythonCandidateSource, string> = {
	override: "PIT_EVAL_PYTHON",
	"virtual-env": "VIRTUAL_ENV",
	"local-.venv": ".venv",
	"local-venv": "venv",
	path: "PATH",
};

export class PythonResolutionError extends Error {
	readonly attempts: readonly Attempt[];

	constructor(cwd: string, attempts: readonly Attempt[]) {
		super(
			`No usable Python interpreter found for eval in ${cwd}. Searched PIT_EVAL_PYTHON, VIRTUAL_ENV, .venv, venv and PATH. ` +
				"Create .venv, activate an environment, or set PIT_EVAL_PYTHON to a valid interpreter." +
				(attempts.length > 0
					? ` Details: ${attempts.map((a) => `${SOURCE_LABELS[a.source]} (${a.reason})`).join("; ")}`
					: ""),
		);
		this.name = "PythonResolutionError";
		this.attempts = attempts;
	}
}

function interpreterName(platform: NodeJS.Platform, root: string): string {
	const pathApi = platform === "win32" ? win32 : posix;
	return platform === "win32" ? pathApi.join(root, "Scripts", "python.exe") : pathApi.join(root, "bin", "python");
}

function defaultIsExecutable(path: string, platform: NodeJS.Platform): boolean {
	if (!existsSync(path)) return false;
	if (platform === "win32") return true;
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function pathCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
	const pathValue = env.PATH ?? env.Path ?? "";
	const names = platform === "win32" ? ["python", "python3"] : ["python3", "python"];
	const pathDelimiter = platform === "win32" ? ";" : ":";
	const extensions = platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
	const result: string[] = [];
	for (const directory of pathValue.split(pathDelimiter)) {
		if (!directory) continue;
		for (const name of names) {
			const pathApi = platform === "win32" ? win32 : posix;
			for (const extension of extensions) result.push(pathApi.join(directory, `${name}${extension}`));
		}
	}
	return result;
}

export function resolvePython(options: PythonResolverOptions): ResolvedPython {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const isFile = options.isFile ?? existsSync;
	const isExecutable = options.isExecutable ?? ((path: string) => defaultIsExecutable(path, platform));
	const pathApi = platform === "win32" ? win32 : posix;
	const attempts: Attempt[] = [];
	const seen = new Set<string>();

	const tryCandidate = (
		source: PythonCandidateSource,
		candidate: string,
		explicit: boolean,
	): ResolvedPython | undefined => {
		const normalized = pathApi.normalize(pathApi.resolve(options.cwd, candidate));
		const key = platform === "win32" ? normalized.toLowerCase() : normalized;
		if (seen.has(key)) return undefined;
		seen.add(key);
		if (!isFile(normalized)) {
			attempts.push({ source, candidate: normalized, reason: "not found" });
			if (explicit) throw new PythonResolutionError(options.cwd, attempts);
			return undefined;
		}
		if (!isExecutable(normalized)) {
			attempts.push({ source, candidate: normalized, reason: "not executable" });
			if (explicit) throw new PythonResolutionError(options.cwd, attempts);
			return undefined;
		}
		return { command: normalized, source };
	};

	const override = env.PIT_EVAL_PYTHON;
	if (override !== undefined) return tryCandidate("override", override, true) as ResolvedPython;
	if (env.VIRTUAL_ENV) {
		const resolved = tryCandidate("virtual-env", interpreterName(platform, env.VIRTUAL_ENV), false);
		if (resolved) return resolved;
	}
	for (const [source, dir] of [
		["local-.venv", ".venv"],
		["local-venv", "venv"],
	] as const) {
		const resolved = tryCandidate(source, interpreterName(platform, pathApi.join(options.cwd, dir)), false);
		if (resolved) return resolved;
	}
	for (const candidate of pathCandidates(env, platform)) {
		const resolved = tryCandidate("path", candidate, false);
		if (resolved) return resolved;
	}
	throw new PythonResolutionError(options.cwd, attempts);
}

export function describePythonSource(source: PythonCandidateSource): string {
	return SOURCE_LABELS[source];
}
