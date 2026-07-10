/**
 * Web-project detection and URL resolution for the functional web DoD gate.
 *
 * Pure I/O helpers (no Chrome deps) so they unit-test on their own. Fail-open:
 * return null when the cwd is not a web project or no safe local URL can be
 * resolved — the gate then skips instead of blocking the turn.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ResolvedTarget, resolvePreviewTarget } from "../preview/preview-server.ts";

const WEB_SCRIPTS = ["dev", "start", "preview", "serve"] as const;

const WEB_DEP_MARKERS = [
	"react",
	"react-dom",
	"vue",
	"@vue/runtime-dom",
	"svelte",
	"next",
	"nuxt",
	"vite",
	"@angular/core",
	"@sveltejs/kit",
	"astro",
	"solid-js",
	"preact",
	"gatsby",
	"remix",
	"@remix-run/react",
] as const;

const STATIC_MARKERS = [
	"index.html",
	"public/index.html",
	"src/index.html",
	"app/page.tsx",
	"app/page.jsx",
	"pages/index.tsx",
	"pages/index.jsx",
	"src/App.tsx",
	"src/App.jsx",
	"src/main.tsx",
	"src/main.jsx",
] as const;

export type WebProjectKind = "static" | "dev-server";

export interface WebProjectDetection {
	kind: WebProjectKind;
	/** Suggested default port when probing localhost (vite 5173, next 3000, …). */
	defaultPort?: number;
	/** Human-readable reason for diagnostics. */
	reason: string;
}

export interface BackgroundJobLike {
	command: string;
	ringBuffer?: string;
	exited?: boolean;
}

export interface ResolveFunctionalWebUrlInput {
	cwd: string;
	lastVisualFile?: string;
	backgroundJobs?: BackgroundJobLike[];
	/** Injected for tests — defaults to a real HTTP probe of localhost ports. */
	probePort?: (port: number) => Promise<boolean>;
}

/**
 * True when the URL is a local loopback origin the functional gate is allowed
 * to navigate (no arbitrary external hosts).
 */
export function isAllowedFunctionalWebUrl(url: string): boolean {
	try {
		const u = new URL(url);
		if (u.protocol !== "http:" && u.protocol !== "https:") return false;
		const host = u.hostname.toLowerCase();
		return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
	} catch {
		return false;
	}
}

/** Parse a Vite/Next/webpack-style "Local: http://localhost:5173/" line. */
export function parseLocalhostUrlFromOutput(text: string): string | undefined {
	const patterns = [
		/\bLocal:\s+(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]*)?)/i,
		/\b(?:ready|listening|running)\s+(?:on\s+)?(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]*)?)/i,
		/\b(https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)(?:\/[^\s]*)?)\b/i,
	];
	for (const re of patterns) {
		const m = text.match(re);
		if (m?.[1] && isAllowedFunctionalWebUrl(m[1])) {
			return m[1].replace(/[.,;:!?)\]}]+$/, "");
		}
	}
	return undefined;
}

function readPackageJson(cwd: string): {
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
} | null {
	const path = join(cwd, "package.json");
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as {
			scripts?: Record<string, string>;
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
	} catch {
		return null;
	}
}

function hasWebScript(scripts: Record<string, string> | undefined): string | undefined {
	if (!scripts) return undefined;
	for (const name of WEB_SCRIPTS) {
		if (typeof scripts[name] === "string" && scripts[name].trim().length > 0) return name;
	}
	return undefined;
}

function hasWebDep(pkg: {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}): string | undefined {
	const all = { ...pkg.dependencies, ...pkg.devDependencies };
	for (const name of WEB_DEP_MARKERS) {
		if (all[name]) return name;
	}
	return undefined;
}

function inferDefaultPort(pkg: {
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}): number {
	const all = { ...pkg.dependencies, ...pkg.devDependencies };
	const scripts = Object.values(pkg.scripts ?? {}).join(" ");
	if (all.next || /\bnext\b/i.test(scripts)) return 3000;
	if (all.nuxt || /\bnuxt\b/i.test(scripts)) return 3000;
	if (all.astro || /\bastro\b/i.test(scripts)) return 4321;
	if (all.vite || /\bvite\b/i.test(scripts)) return 5173;
	const portMatch = scripts.match(/--port[=\s]+(\d{2,5})/);
	if (portMatch) return Number(portMatch[1]);
	return 5173;
}

function findStaticMarker(cwd: string): string | undefined {
	for (const rel of STATIC_MARKERS) {
		if (existsSync(join(cwd, rel))) return rel;
	}
	return undefined;
}

/**
 * Detect whether `cwd` looks like a web UI project worth a functional DoD check.
 */
export function detectWebProject(cwd: string): WebProjectDetection | null {
	const pkg = readPackageJson(cwd);
	if (pkg) {
		const script = hasWebScript(pkg.scripts);
		const dep = hasWebDep(pkg);
		if (script || dep) {
			return {
				kind: "dev-server",
				defaultPort: inferDefaultPort(pkg),
				reason: script ? `package.json script "${script}"` : `dependency "${dep}"`,
			};
		}
	}
	const marker = findStaticMarker(cwd);
	if (marker) {
		return { kind: "static", reason: `found ${marker}` };
	}
	return null;
}

async function defaultProbePort(port: number): Promise<boolean> {
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 400);
		try {
			const res = await fetch(`http://127.0.0.1:${port}/`, {
				method: "GET",
				signal: ctrl.signal,
				redirect: "manual",
			});
			// Any HTTP response (even 404) means something is listening.
			return res.status > 0;
		} finally {
			clearTimeout(t);
		}
	} catch {
		return false;
	}
}

function isDevServerJob(command: string): boolean {
	return /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|preview|serve)\b/i.test(command) || /\bvite\b/i.test(command);
}

/**
 * Resolve a navigable local URL for the functional web gate.
 *
 * Priority:
 * 1. last visual file / dir via resolvePreviewTarget (ephemeral server if needed)
 * 2. localhost URL parsed from a running background dev-server job
 * 3. probe common localhost ports for a live server
 * 4. static index.html via ephemeral preview server when detectWebProject is static
 */
export async function resolveFunctionalWebUrl(input: ResolveFunctionalWebUrlInput): Promise<ResolvedTarget | null> {
	const { cwd, lastVisualFile, backgroundJobs, probePort = defaultProbePort } = input;

	if (lastVisualFile) {
		try {
			const resolved = await resolvePreviewTarget(lastVisualFile, cwd);
			if (isAllowedFunctionalWebUrl(resolved.url)) return resolved;
			// External URL from a mis-tagged visual file — refuse.
			await resolved.server?.close();
		} catch {
			// Fall through to other strategies.
		}
	}

	if (backgroundJobs) {
		for (const job of backgroundJobs) {
			if (job.exited) continue;
			if (!isDevServerJob(job.command)) continue;
			const fromCmd = parseLocalhostUrlFromOutput(job.command);
			if (fromCmd) return { url: fromCmd, label: fromCmd };
			const fromRing = job.ringBuffer ? parseLocalhostUrlFromOutput(job.ringBuffer) : undefined;
			if (fromRing) return { url: fromRing, label: fromRing };
		}
	}

	const detection = detectWebProject(cwd);
	if (!detection) return null;

	if (detection.kind === "dev-server") {
		const ports = Array.from(new Set([detection.defaultPort ?? 5173, 5173, 3000, 4173, 8080, 4321].filter(Boolean)));
		for (const port of ports) {
			if (await probePort(port)) {
				const url = `http://127.0.0.1:${port}/`;
				return { url, label: url };
			}
		}
		// Dev-server project but nothing listening — cannot invent a live URL.
		return null;
	}

	// Static: serve index.html / project root.
	const staticCandidates = ["index.html", "public/index.html", "src/index.html", "."];
	for (const rel of staticCandidates) {
		const abs = join(cwd, rel);
		if (rel !== "." && !existsSync(abs)) continue;
		try {
			const resolved = await resolvePreviewTarget(rel === "." ? cwd : abs, cwd);
			if (isAllowedFunctionalWebUrl(resolved.url)) return resolved;
			await resolved.server?.close();
		} catch {
			// try next
		}
	}

	return null;
}
