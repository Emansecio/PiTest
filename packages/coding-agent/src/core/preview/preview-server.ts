/**
 * Ephemeral static file server for the `preview` tool.
 *
 * The Chrome companion blocks `file://` navigation, so previewing a local HTML
 * file or a built static site needs a real `http://` origin. This serves a
 * directory on an ephemeral 127.0.0.1 port for the lifetime of one preview and
 * is torn down right after. Pure Node (no Chrome dep) so it is unit-testable on
 * its own. Path traversal outside the served root is rejected.
 */

import { readFile, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";

export interface PreviewServer {
	/** Base URL ending in `/` (e.g. http://127.0.0.1:54321/). */
	url: string;
	port: number;
	/** Stop the server and release the port. */
	close(): Promise<void>;
}

export interface ResolvedTarget {
	/** Fully-qualified URL to navigate Chrome to. */
	url: string;
	/** Present when we started an ephemeral server — the caller MUST close it. */
	server?: PreviewServer;
	/** Human-readable description for the tool output. */
	label: string;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".cjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".wasm": "application/wasm",
	".txt": "text/plain; charset=utf-8",
};

export function mimeForPath(p: string): string {
	return MIME[extname(p).toLowerCase()] ?? "application/octet-stream";
}

async function serveRequest(root: string, rawUrl: string, res: ServerResponse): Promise<void> {
	// decodeURIComponent throws on a malformed %-escape; unguarded (the try below
	// starts later) that becomes an unhandledRejection with the socket left hung.
	let pathname: string;
	try {
		pathname = decodeURIComponent((rawUrl.split(/[?#]/)[0] || "/").trim());
	} catch {
		res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
		res.end("Bad Request");
		return;
	}
	const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	const filePath = normalize(join(root, rel));
	// Path-traversal guard: the resolved file must stay inside root.
	if (filePath !== root && !filePath.startsWith(root + sep)) {
		res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
		res.end("Forbidden");
		return;
	}
	try {
		let target = filePath;
		const s = await stat(target).catch(() => undefined);
		if (s?.isDirectory()) target = join(target, "index.html");
		const body = await readFile(target);
		res.writeHead(200, { "content-type": mimeForPath(target), "cache-control": "no-store" });
		res.end(body);
	} catch {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("Not found");
	}
}

/**
 * Start an ephemeral static server rooted at `root` on 127.0.0.1:<random port>.
 * The caller owns the returned server and must `close()` it.
 */
export async function startPreviewServer(root: string): Promise<PreviewServer> {
	const rootResolved = resolve(root);
	const server = createServer((req, res) => {
		void serveRequest(rootResolved, req.url ?? "/", res);
	});
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolvePromise());
	});
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return {
		url: `http://127.0.0.1:${port}/`,
		port,
		close: () =>
			new Promise<void>((resolvePromise) => {
				server.close(() => resolvePromise());
			}),
	};
}

/**
 * Resolve a preview target to a navigable URL, starting an ephemeral static
 * server for local files/dirs so the `file://` block does not apply.
 *
 * - `http(s)://…`, `localhost…`, `127.0.0.1…` → used as a URL (no server).
 * - existing local directory → served; URL points at its `index.html`.
 * - existing local `.html` (any file) → its directory is served; URL points at it.
 *
 * @throws when a non-URL target does not exist on disk.
 */
export async function resolvePreviewTarget(target: string, cwd: string): Promise<ResolvedTarget> {
	const t = target.trim();
	if (/^https?:\/\//i.test(t)) return { url: t, label: t };
	if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(t)) {
		return { url: `http://${t}`, label: `http://${t}` };
	}
	const abs = resolve(cwd, t);
	const s = await stat(abs).catch(() => undefined);
	if (!s) throw new Error(`Preview target not found: "${target}" — pass a URL, an HTML file, or a directory.`);
	if (s.isDirectory()) {
		const server = await startPreviewServer(abs);
		return { url: server.url, server, label: `${target}/ (served locally)` };
	}
	const server = await startPreviewServer(dirname(abs));
	return { url: `${server.url}${encodeURIComponent(basename(abs))}`, server, label: `${target} (served locally)` };
}
