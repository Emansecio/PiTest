/**
 * `issue://` URL scheme: GitHub issues via the `gh` CLI.
 *
 * Forms:
 *   issue://<number>
 *   issue://<owner>/<repo>/<number>
 */

import { execFile } from "node:child_process";
import type { UrlContext, UrlReadResult, UrlSchemeResolver } from "./registry.ts";

interface IssueUrlParts {
	owner?: string;
	repo?: string;
	number: string;
}

const GH_INSTALL_HINT = "gh CLI not installed; install via https://cli.github.com/ to use issue:// scheme";
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

function parseIssueUrl(url: URL): IssueUrlParts | { error: string } {
	const host = decodeURIComponent(url.hostname);
	const segments = url.pathname
		.split("/")
		.filter((s) => s.length > 0)
		.map(decodeURIComponent);
	if (!host) return { error: "invalid issue:// URL: missing issue number" };
	if (/^\d+$/.test(host)) return { number: host };
	if (segments.length < 2) {
		return { error: "invalid issue:// URL: expected issue://<number> or issue://<owner>/<repo>/<number>" };
	}
	const number = segments[1];
	if (!/^\d+$/.test(number)) return { error: `invalid issue number: ${number}` };
	return { owner: host, repo: segments[0], number };
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

function formatIssue(json: unknown, parts: IssueUrlParts): string {
	const data = (json ?? {}) as Record<string, unknown>;
	const title = String(data.title ?? "");
	const state = String(data.state ?? "");
	const body = String(data.body ?? "");
	const labels = Array.isArray(data.labels) ? (data.labels as Array<Record<string, unknown>>) : [];
	const comments = Array.isArray(data.comments) ? (data.comments as Array<Record<string, unknown>>) : [];

	const scope = parts.owner && parts.repo ? ` (${parts.owner}/${parts.repo})` : "";
	const lines: string[] = [];
	lines.push(`# Issue #${parts.number}${scope}: ${title}`);
	lines.push("");
	lines.push(`- state: ${state}`);
	if (labels.length > 0) {
		const names = labels.map((l) => String(l.name ?? "")).filter((n) => n.length > 0);
		if (names.length > 0) lines.push(`- labels: ${names.join(", ")}`);
	}
	lines.push("");
	if (body.trim().length > 0) {
		lines.push("## Description");
		lines.push("");
		lines.push(body);
		lines.push("");
	}
	if (comments.length > 0) {
		lines.push(`## Comments (${comments.length})`);
		lines.push("");
		for (const c of comments) {
			const author = ((c.author as Record<string, unknown> | undefined)?.login as string | undefined) ?? "unknown";
			const created = String(c.createdAt ?? "");
			const cbody = String(c.body ?? "");
			lines.push(`### ${author} — ${created}`);
			lines.push("");
			lines.push(cbody);
			lines.push("");
		}
	}
	return lines.join("\n");
}

export function createIssueSchemeResolver(): UrlSchemeResolver {
	return {
		scheme: "issue",
		async read(url: URL, ctx: UrlContext): Promise<UrlReadResult> {
			const parsed = parseIssueUrl(url);
			if ("error" in parsed) return { kind: "error", error: parsed.error };
			const authStatus = await ensureGhAuth(ctx.cwd);
			if (authStatus === "not-installed") {
				return { kind: "error", error: GH_INSTALL_HINT };
			}
			if (authStatus === "unauthenticated") {
				return { kind: "error", error: GH_AUTH_HINT };
			}
			const repoArgs = parsed.owner && parsed.repo ? ["--repo", `${parsed.owner}/${parsed.repo}`] : [];
			const res = await runGh(
				[...repoArgs, "issue", "view", parsed.number, "--json", "title,body,state,labels,comments"],
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
					error: `gh issue view #${parsed.number} failed: ${res.stderr.trim() || res.stdout.trim()}`,
				};
			}
			let parsedJson: unknown;
			try {
				parsedJson = JSON.parse(res.stdout);
			} catch (err) {
				return { kind: "error", error: `failed to parse gh JSON output: ${(err as Error).message}` };
			}
			return { kind: "text", content: formatIssue(parsedJson, parsed), mimeType: "text/markdown" };
		},
	};
}
