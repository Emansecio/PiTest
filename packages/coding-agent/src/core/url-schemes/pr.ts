/**
 * `pr://` URL scheme: GitHub pull requests via the `gh` CLI.
 *
 * Forms:
 *   pr://<number>                   PR overview (title, body, state, files, commits)
 *   pr://<owner>/<repo>/<number>    Same, scoped to a specific repo
 *   pr://<number>/diff              Full unified diff
 *   pr://<number>/diff/<n>          Nth file's diff chunk (1-indexed)
 */

import { execFile } from "node:child_process";
import type { UrlContext, UrlReadResult, UrlSchemeResolver } from "./registry.ts";

interface PrUrlParts {
	owner?: string;
	repo?: string;
	number: string;
	view: "overview" | "diff";
	chunkIndex?: number;
}

const GH_INSTALL_HINT = "gh CLI not installed; install via https://cli.github.com/ to use pr:// scheme";
const GH_AUTH_HINT = "gh CLI is installed but not authenticated. Run: gh auth login";

type GhAuthStatus = "ok" | "unauthenticated" | "not-installed";

// Module-level cache. Only the positive ("ok") result is memoized permanently;
// negative results carry a short TTL so they self-heal once gh becomes
// installed/authenticated mid-session (no agent restart required).
const GH_AUTH_NEGATIVE_TTL_MS = 30_000;
let ghAuthCache: GhAuthStatus | undefined;
let ghAuthCacheExpiry = 0;

function probeGhAuth(cwd: string): Promise<GhAuthStatus> {
	return new Promise((resolve) => {
		execFile("gh", ["auth", "status"], { cwd, maxBuffer: 1 * 1024 * 1024, windowsHide: true }, (err) => {
			if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
				resolve("not-installed");
				return;
			}
			if (err) {
				resolve("unauthenticated");
				return;
			}
			resolve("ok");
		});
	});
}

async function ensureGhAuth(cwd: string): Promise<GhAuthStatus> {
	if (ghAuthCache === "ok") return ghAuthCache;
	if (ghAuthCache !== undefined && Date.now() < ghAuthCacheExpiry) return ghAuthCache;
	const status = await probeGhAuth(cwd);
	ghAuthCache = status;
	ghAuthCacheExpiry = status === "ok" ? 0 : Date.now() + GH_AUTH_NEGATIVE_TTL_MS;
	return status;
}

function invalidateGhAuthCache(): void {
	ghAuthCache = undefined;
	ghAuthCacheExpiry = 0;
}

function looksLikeAuthError(stderr: string): boolean {
	return /not logged in|authentication/i.test(stderr);
}

function parsePrUrl(url: URL): PrUrlParts | { error: string } {
	// URL parsing for `pr://1428/diff/1`:
	// - host -> "1428"
	// - pathname -> "/diff/1"
	// For `pr://owner/repo/42`:
	// - host -> "owner"
	// - pathname -> "/repo/42"
	const host = decodeURIComponent(url.hostname);
	const segments = url.pathname
		.split("/")
		.filter((s) => s.length > 0)
		.map(decodeURIComponent);

	if (!host) return { error: "invalid pr:// URL: missing PR number" };

	// Case A: pr://<number>[/diff[/<n>]]
	if (/^\d+$/.test(host)) {
		const parts: PrUrlParts = { number: host, view: "overview" };
		if (segments.length === 0) return parts;
		if (segments[0] === "diff") {
			parts.view = "diff";
			if (segments.length >= 2) {
				const idx = Number.parseInt(segments[1], 10);
				if (!Number.isFinite(idx) || idx < 1) {
					return { error: `invalid diff chunk index: ${segments[1]}` };
				}
				parts.chunkIndex = idx;
			}
			return parts;
		}
		return { error: `unrecognized pr:// path segment: ${segments[0]}` };
	}

	// Case B: pr://<owner>/<repo>/<number>[/diff[/<n>]]
	if (segments.length < 2) {
		return { error: "invalid pr:// URL: expected pr://<number> or pr://<owner>/<repo>/<number>" };
	}
	const owner = host;
	const repo = segments[0];
	const number = segments[1];
	if (!/^\d+$/.test(number)) return { error: `invalid PR number: ${number}` };
	const parts: PrUrlParts = { owner, repo, number, view: "overview" };
	if (segments.length >= 3 && segments[2] === "diff") {
		parts.view = "diff";
		if (segments.length >= 4) {
			const idx = Number.parseInt(segments[3], 10);
			if (!Number.isFinite(idx) || idx < 1) {
				return { error: `invalid diff chunk index: ${segments[3]}` };
			}
			parts.chunkIndex = idx;
		}
	}
	return parts;
}

interface GhExecResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

function runGh(args: string[], ctx: UrlContext): Promise<GhExecResult | { notInstalled: true }> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			child.kill();
		};
		const cleanup = () => {
			ctx.signal?.removeEventListener("abort", onAbort);
		};
		const child = execFile(
			"gh",
			args,
			{ cwd: ctx.cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
			(err, stdout, stderr) => {
				cleanup();
				if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
					resolve({ notInstalled: true });
					return;
				}
				if (err && typeof (err as { code?: number }).code === "number") {
					// Non-zero exit: surface stderr to the caller, do not reject.
					resolve({ stdout: String(stdout), stderr: String(stderr), code: (err as { code: number }).code });
					return;
				}
				if (err) {
					reject(err);
					return;
				}
				resolve({ stdout: String(stdout), stderr: String(stderr), code: 0 });
			},
		);
		if (ctx.signal) {
			if (ctx.signal.aborted) child.kill();
			else ctx.signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function repoFlag(parts: PrUrlParts): string[] {
	if (parts.owner && parts.repo) return ["--repo", `${parts.owner}/${parts.repo}`];
	return [];
}

function formatOverview(json: unknown, parts: PrUrlParts): string {
	const data = (json ?? {}) as Record<string, unknown>;
	const title = String(data.title ?? "");
	const state = String(data.state ?? "");
	const base = String(data.baseRefName ?? "");
	const head = String(data.headRefName ?? "");
	const body = String(data.body ?? "");
	const files = Array.isArray(data.files) ? (data.files as Array<Record<string, unknown>>) : [];
	const commits = Array.isArray(data.commits) ? (data.commits as Array<Record<string, unknown>>) : [];

	const lines: string[] = [];
	const scope = parts.owner && parts.repo ? ` (${parts.owner}/${parts.repo})` : "";
	lines.push(`# PR #${parts.number}${scope}: ${title}`);
	lines.push("");
	lines.push(`- state: ${state}`);
	lines.push(`- base: ${base}`);
	lines.push(`- head: ${head}`);
	lines.push("");
	if (body.trim().length > 0) {
		lines.push("## Description");
		lines.push("");
		lines.push(body);
		lines.push("");
	}
	if (files.length > 0) {
		lines.push(`## Files (${files.length})`);
		lines.push("");
		for (const f of files) {
			const path = String(f.path ?? "");
			const additions = f.additions ?? "";
			const deletions = f.deletions ?? "";
			lines.push(`- ${path} (+${additions} -${deletions})`);
		}
		lines.push("");
	}
	if (commits.length > 0) {
		lines.push(`## Commits (${commits.length})`);
		lines.push("");
		for (const c of commits) {
			const oid = String(c.oid ?? "").slice(0, 7);
			const messageHeadline = String(c.messageHeadline ?? "");
			lines.push(`- ${oid} ${messageHeadline}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

interface DiffChunk {
	header: string;
	body: string;
}

function splitDiffIntoChunks(diff: string): DiffChunk[] {
	const lines = diff.split("\n");
	const chunks: DiffChunk[] = [];
	let current: DiffChunk | undefined;
	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			if (current) chunks.push(current);
			current = { header: line, body: line };
		} else if (current) {
			current.body += `\n${line}`;
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

export function createPrSchemeResolver(): UrlSchemeResolver {
	return {
		scheme: "pr",
		async read(url: URL, ctx: UrlContext): Promise<UrlReadResult> {
			const parsed = parsePrUrl(url);
			if ("error" in parsed) return { kind: "error", error: parsed.error };

			if (parsed.view === "overview") {
				const authStatus = await ensureGhAuth(ctx.cwd);
				if (authStatus === "not-installed") {
					return { kind: "error", error: GH_INSTALL_HINT };
				}
				if (authStatus === "unauthenticated") {
					return { kind: "error", error: GH_AUTH_HINT };
				}
				const res = await runGh(
					[
						...repoFlag(parsed),
						"pr",
						"view",
						parsed.number,
						"--json",
						"title,body,state,commits,files,baseRefName,headRefName",
					],
					ctx,
				);
				if ("notInstalled" in res) {
					invalidateGhAuthCache();
					return { kind: "error", error: GH_INSTALL_HINT };
				}
				if (res.code !== 0) {
					if (looksLikeAuthError(res.stderr)) {
						// Auth dropped after a previously-cached "ok"; force a re-probe next read.
						invalidateGhAuthCache();
						return { kind: "error", error: GH_AUTH_HINT };
					}
					return {
						kind: "error",
						error: `gh pr view #${parsed.number} failed: ${res.stderr.trim() || res.stdout.trim()}`,
					};
				}
				let parsedJson: unknown;
				try {
					parsedJson = JSON.parse(res.stdout);
				} catch (err) {
					return { kind: "error", error: `failed to parse gh JSON output: ${(err as Error).message}` };
				}
				return { kind: "text", content: formatOverview(parsedJson, parsed), mimeType: "text/markdown" };
			}

			// view === "diff"
			const authStatus = await ensureGhAuth(ctx.cwd);
			if (authStatus === "not-installed") {
				return { kind: "error", error: GH_INSTALL_HINT };
			}
			if (authStatus === "unauthenticated") {
				return { kind: "error", error: GH_AUTH_HINT };
			}
			const res = await runGh([...repoFlag(parsed), "pr", "diff", parsed.number], ctx);
			if ("notInstalled" in res) {
				invalidateGhAuthCache();
				return { kind: "error", error: GH_INSTALL_HINT };
			}
			if (res.code !== 0) {
				if (looksLikeAuthError(res.stderr)) {
					// Auth dropped after a previously-cached "ok"; force a re-probe next read.
					invalidateGhAuthCache();
					return { kind: "error", error: GH_AUTH_HINT };
				}
				return {
					kind: "error",
					error: `gh pr diff #${parsed.number} failed: ${res.stderr.trim() || res.stdout.trim()}`,
				};
			}
			const fullDiff = res.stdout;
			if (parsed.chunkIndex === undefined) {
				return { kind: "text", content: fullDiff, mimeType: "text/x-diff" };
			}
			const chunks = splitDiffIntoChunks(fullDiff);
			if (parsed.chunkIndex < 1 || parsed.chunkIndex > chunks.length) {
				return {
					kind: "error",
					error: `diff chunk ${parsed.chunkIndex} out of range (PR has ${chunks.length} file diffs)`,
				};
			}
			return {
				kind: "text",
				content: chunks[parsed.chunkIndex - 1].body,
				mimeType: "text/x-diff",
			};
		},
	};
}
