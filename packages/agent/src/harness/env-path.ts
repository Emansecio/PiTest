/**
 * Separator-agnostic path helpers for ExecutionEnv path strings.
 *
 * Paths produced by an ExecutionEnv are not guaranteed to use a single
 * separator: NodeExecutionEnv emits native paths (backslashes on Windows) while
 * other envs / callers use forward slashes. These helpers therefore accept both
 * "/" and "\\" and normalize their output to "/", so callers (skills, prompt
 * templates, ignore matching) behave identically on every platform. Keeping them
 * in one module avoids the duplicated, POSIX-only copies that previously broke on
 * Windows.
 */

/** Join `base` and `child` with a single "/", tolerating either separator at the seam. */
export function joinEnvPath(base: string, child: string): string {
	return `${base.replace(/[\\/]+$/, "")}/${child.replace(/^[\\/]+/, "")}`;
}

/** Parent directory of `path` ("/" if there is no parent), separator-agnostic. */
export function dirnameEnvPath(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	const slashIndex = normalized.lastIndexOf("/");
	return slashIndex <= 0 ? "/" : normalized.slice(0, slashIndex);
}

/** Last path segment of `path`, tolerating either separator. */
export function basenameEnvPath(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	const slashIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

/** `path` relative to `root` as a "/"-separated string ("" when equal), separator-agnostic. */
export function relativeEnvPath(root: string, path: string): string {
	const toPosix = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
	const normalizedRoot = toPosix(root);
	const normalizedPath = toPosix(path);
	if (normalizedPath === normalizedRoot) return "";
	return normalizedPath.startsWith(`${normalizedRoot}/`)
		? normalizedPath.slice(normalizedRoot.length + 1)
		: normalizedPath.replace(/^\/+/, "");
}
