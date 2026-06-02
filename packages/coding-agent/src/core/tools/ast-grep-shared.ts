export const AST_GREP_INSTALL_HINT =
	"ast-grep CLI not installed. Install: https://ast-grep.github.io/guide/quick-start.html";

export function isMissingBinaryError(err: NodeJS.ErrnoException | Error): boolean {
	const code = (err as NodeJS.ErrnoException).code;
	if (code === "ENOENT") return true;
	const message = (err.message || "").toLowerCase();
	return message.includes("command not found") || message.includes("not recognized") || message.includes("enoent");
}

export function parseJsonStream<T extends object>(stdout: string): T[] {
	const out: T[] = [];
	const trimmed = stdout.trim();
	if (!trimmed) return out;
	if (trimmed.startsWith("[")) {
		try {
			const arr = JSON.parse(trimmed);
			if (Array.isArray(arr)) for (const m of arr) if (m && typeof m === "object") out.push(m as T);
		} catch {
			// fall through
		}
		if (out.length > 0) return out;
	}
	for (const line of trimmed.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const parsed = JSON.parse(t);
			if (parsed && typeof parsed === "object") out.push(parsed as T);
		} catch {
			// skip
		}
	}
	return out;
}
