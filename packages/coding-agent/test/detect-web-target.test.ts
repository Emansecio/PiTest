import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	detectWebProject,
	isAllowedFunctionalWebUrl,
	parseLocalhostUrlFromOutput,
	resolveFunctionalWebUrl,
} from "../src/core/verification/detect-web-target.js";

describe("detect-web-target", () => {
	const temps: string[] = [];
	afterEach(() => {
		while (temps.length > 0) {
			rmSync(temps.pop()!, { recursive: true, force: true });
		}
	});

	function temp(): string {
		const dir = mkdtempSync(join(tmpdir(), "web-target-"));
		temps.push(dir);
		return dir;
	}

	it("isAllowedFunctionalWebUrl accepts only loopback", () => {
		expect(isAllowedFunctionalWebUrl("http://localhost:5173/")).toBe(true);
		expect(isAllowedFunctionalWebUrl("http://127.0.0.1:3000")).toBe(true);
		expect(isAllowedFunctionalWebUrl("https://example.com")).toBe(false);
		expect(isAllowedFunctionalWebUrl("not-a-url")).toBe(false);
	});

	it("parseLocalhostUrlFromOutput extracts Vite-style Local lines", () => {
		expect(parseLocalhostUrlFromOutput("  ➜  Local:   http://localhost:5173/\n")).toBe("http://localhost:5173/");
		expect(parseLocalhostUrlFromOutput("ready on http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
		expect(parseLocalhostUrlFromOutput("https://evil.example")).toBeUndefined();
	});

	it("detectWebProject finds vite script + react dep", () => {
		const dir = temp();
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({
				scripts: { dev: "vite" },
				dependencies: { react: "^19" },
			}),
		);
		const d = detectWebProject(dir);
		expect(d).not.toBeNull();
		expect(d!.kind).toBe("dev-server");
		expect(d!.defaultPort).toBe(5173);
	});

	it("detectWebProject finds next default port 3000", () => {
		const dir = temp();
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({
				scripts: { dev: "next dev" },
				dependencies: { next: "^15" },
			}),
		);
		expect(detectWebProject(dir)?.defaultPort).toBe(3000);
	});

	it("detectWebProject finds static index.html", () => {
		const dir = temp();
		writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
		const d = detectWebProject(dir);
		expect(d?.kind).toBe("static");
		expect(d?.reason).toContain("index.html");
	});

	it("detectWebProject returns null for empty dir", () => {
		expect(detectWebProject(temp())).toBeNull();
	});

	it("resolveFunctionalWebUrl prefers lastVisualFile via preview server", async () => {
		const dir = temp();
		const file = join(dir, "page.html");
		writeFileSync(file, "<html><body><h1>x</h1></body></html>");
		const resolved = await resolveFunctionalWebUrl({
			cwd: dir,
			lastVisualFile: file,
			probePort: async () => false,
		});
		expect(resolved).not.toBeNull();
		expect(isAllowedFunctionalWebUrl(resolved!.url)).toBe(true);
		await resolved!.server?.close();
	});

	it("resolveFunctionalWebUrl uses background job ring buffer URL", async () => {
		const dir = temp();
		writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
		const resolved = await resolveFunctionalWebUrl({
			cwd: dir,
			backgroundJobs: [
				{
					command: "npm run dev",
					ringBuffer: "  ➜  Local:   http://localhost:5173/\n",
					exited: false,
				},
			],
			probePort: async () => false,
		});
		expect(resolved?.url).toBe("http://localhost:5173/");
	});

	it("resolveFunctionalWebUrl probes default ports for live server", async () => {
		const dir = temp();
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ scripts: { dev: "vite" }, dependencies: { vite: "^6" } }),
		);
		const probed: number[] = [];
		const resolved = await resolveFunctionalWebUrl({
			cwd: dir,
			probePort: async (port) => {
				probed.push(port);
				return port === 5173;
			},
		});
		expect(resolved?.url).toBe("http://127.0.0.1:5173/");
		expect(probed).toContain(5173);
	});

	it("resolveFunctionalWebUrl serves static project when no live server", async () => {
		const dir = temp();
		mkdirSync(join(dir, "public"), { recursive: true });
		writeFileSync(join(dir, "public", "index.html"), "<h1>static</h1>");
		const resolved = await resolveFunctionalWebUrl({
			cwd: dir,
			probePort: async () => false,
		});
		expect(resolved).not.toBeNull();
		expect(isAllowedFunctionalWebUrl(resolved!.url)).toBe(true);
		await resolved!.server?.close();
	});
});
