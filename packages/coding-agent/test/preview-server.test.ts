import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mimeForPath, resolvePreviewTarget, startPreviewServer } from "../src/core/preview/preview-server.js";

describe("preview-server", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pit-preview-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	describe("mimeForPath", () => {
		it("maps common extensions and defaults to octet-stream", () => {
			expect(mimeForPath("a.html")).toContain("text/html");
			expect(mimeForPath("UP.CSS")).toContain("text/css");
			expect(mimeForPath("x.png")).toBe("image/png");
			expect(mimeForPath("x.svg")).toBe("image/svg+xml");
			expect(mimeForPath("x.unknownext")).toBe("application/octet-stream");
		});
	});

	describe("startPreviewServer", () => {
		it("serves a file with the right content-type and body", async () => {
			await writeFile(join(dir, "page.html"), "<h1>hi</h1>");
			const server = await startPreviewServer(dir);
			try {
				expect(server.port).toBeGreaterThan(0);
				const res = await fetch(`${server.url}page.html`);
				expect(res.status).toBe(200);
				expect(res.headers.get("content-type")).toContain("text/html");
				expect(await res.text()).toBe("<h1>hi</h1>");
			} finally {
				await server.close();
			}
		});

		it("maps / to index.html", async () => {
			await writeFile(join(dir, "index.html"), "<title>root</title>");
			const server = await startPreviewServer(dir);
			try {
				const res = await fetch(server.url);
				expect(res.status).toBe(200);
				expect(await res.text()).toContain("root");
			} finally {
				await server.close();
			}
		});

		it("404s a missing file", async () => {
			const server = await startPreviewServer(dir);
			try {
				const res = await fetch(`${server.url}nope.html`);
				expect(res.status).toBe(404);
			} finally {
				await server.close();
			}
		});
	});

	describe("resolvePreviewTarget", () => {
		it("passes through http(s) URLs without starting a server", async () => {
			const r = await resolvePreviewTarget("https://example.com/app", dir);
			expect(r.url).toBe("https://example.com/app");
			expect(r.server).toBeUndefined();
		});

		it("treats localhost:port as a URL", async () => {
			const r = await resolvePreviewTarget("localhost:5173", dir);
			expect(r.url).toBe("http://localhost:5173");
			expect(r.server).toBeUndefined();
		});

		it("serves a local directory at its index", async () => {
			await writeFile(join(dir, "index.html"), "<b>dir</b>");
			const r = await resolvePreviewTarget(dir, dir);
			try {
				expect(r.server).toBeDefined();
				const res = await fetch(r.url);
				expect(await res.text()).toContain("dir");
			} finally {
				await r.server?.close();
			}
		});

		it("serves a local HTML file's directory and points at the file", async () => {
			await writeFile(join(dir, "demo.html"), "<b>file</b>");
			const r = await resolvePreviewTarget(join(dir, "demo.html"), dir);
			try {
				expect(r.server).toBeDefined();
				expect(r.url).toContain("demo.html");
				const res = await fetch(r.url);
				expect(await res.text()).toContain("file");
			} finally {
				await r.server?.close();
			}
		});

		it("throws for a non-existent local target", async () => {
			await expect(resolvePreviewTarget("does-not-exist.html", dir)).rejects.toThrow(/not found/i);
		});
	});
});
