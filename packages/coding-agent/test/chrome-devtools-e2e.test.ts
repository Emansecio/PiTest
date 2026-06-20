/**
 * Real-Chrome E2E for the chrome_devtools_* surface. Gated behind
 * PIT_CHROME_E2E=1 because it launches an actual Chrome (dedicated profile,
 * port 9224) — the default suite must stay hermetic and fast.
 *
 *   PIT_CHROME_E2E=1 npx vitest --run test/chrome-devtools-e2e.test.ts
 *
 * Exercises the full interaction loop against a local HTTP server: navigate,
 * waitFor, fill, pressKey, click, hover, selectOption, uploadFile, snapshot
 * (full + scoped), getPageText, screenshot, network buffer + response body,
 * and dead-connection auto-recovery.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChromeDevtoolsManager } from "../src/core/chrome/chrome-devtools-manager.js";

const ENABLED = process.env.PIT_CHROME_E2E === "1";
const suite = ENABLED ? describe : describe.skip;

const CHROME_PORT = 9224;
const HTTP_PORT = 8947;

const PAGE_HTML = `<!doctype html><title>Pit E2E</title>
<nav><a href="#">Home</a></nav>
<div id="tip" style="display:none">tooltip!</div>
<form id="login">
	<input id="q" aria-label="user">
	<button id="b" onclick="document.getElementById('out').textContent='clicked:'+document.getElementById('q').value;return false">Sign in</button>
</form>
<div id="out"></div><div id="k"></div>
<button id="h" onmouseover="document.getElementById('tip').style.display='block'">hover me</button>
<select id="sel"><option value="a">Alpha</option><option value="b">Bravo</option></select><div id="selout"></div>
<input type="file" id="f"><div id="fout"></div>
<script>
document.getElementById('q').addEventListener('keydown',e=>{document.getElementById('k').textContent='key:'+e.key});
document.getElementById('sel').addEventListener('change',e=>{document.getElementById('selout').textContent='sel:'+e.target.value});
document.getElementById('f').addEventListener('change',e=>{document.getElementById('fout').textContent='file:'+e.target.files[0].name});
</script>`;

/** Best-effort kill of whatever listens on the Chrome debug port. */
function killPort(port: number): void {
	try {
		if (process.platform === "win32") {
			const out = execSync(`netstat -ano -p tcp | findstr :${port} | findstr LISTENING`).toString();
			const pid = out.trim().split(/\s+/).pop();
			if (pid) execSync(`taskkill /PID ${pid} /F`);
		} else {
			execSync(`kill -9 $(lsof -ti tcp:${port})`);
		}
	} catch {
		// already gone
	}
}

suite("chrome_devtools real-Chrome E2E (PIT_CHROME_E2E=1)", () => {
	let server: http.Server;
	let mgr: ChromeDevtoolsManager;
	const uploadFile = path.join(os.tmpdir(), "pit-e2e-upload.txt");

	beforeAll(async () => {
		fs.writeFileSync(uploadFile, "hello upload");
		server = http.createServer((req, res) => {
			if (req.url === "/api") {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ secret: "pit-body-ok" }));
				return;
			}
			res.setHeader("content-type", "text/html");
			res.end(PAGE_HTML);
		});
		await new Promise<void>((resolve) => server.listen(HTTP_PORT, "127.0.0.1", resolve));
		mgr = new ChromeDevtoolsManager({
			host: "127.0.0.1",
			port: CHROME_PORT,
			launchBrowser: true,
			userDataDir: path.join(os.tmpdir(), "pit-chrome-e2e-profile"),
		});
	});

	afterAll(async () => {
		mgr?.dispose();
		killPort(CHROME_PORT);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		fs.rmSync(uploadFile, { force: true });
		try {
			// Chrome releases its profile locks asynchronously after the kill.
			fs.rmSync(path.join(os.tmpdir(), "pit-chrome-e2e-profile"), {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 300,
			});
		} catch {
			// best effort — a leftover temp profile is harmless
		}
	});

	it("drives the full interaction surface against a real page", { timeout: 120_000 }, async () => {
		await mgr.navigate({ url: `http://127.0.0.1:${HTTP_PORT}/`, newTab: true });
		expect((await mgr.waitFor({ selector: "#login", timeoutMs: 15_000 })).found).toBe(true);

		// fill + pressKey + click
		await mgr.fill("#q", "ola pit");
		await mgr.pressKey("Enter");
		await mgr.click("#b");
		expect((await mgr.waitFor({ text: "clicked:ola pit", timeoutMs: 5_000 })).found).toBe(true);
		expect((await mgr.waitFor({ text: "key:Enter", timeoutMs: 5_000 })).found).toBe(true);

		// hover reveals the tooltip
		await mgr.hover("#h");
		expect((await mgr.waitFor({ text: "tooltip!", timeoutMs: 5_000 })).found).toBe(true);

		// selectOption by label fires change
		expect(await mgr.selectOption("#sel", "Bravo")).toEqual({ value: "b", label: "Bravo" });
		expect((await mgr.waitFor({ text: "sel:b", timeoutMs: 5_000 })).found).toBe(true);

		// uploadFile reflects in the page's change handler
		await mgr.uploadFile("#f", [uploadFile]);
		expect((await mgr.waitFor({ text: "file:pit-e2e-upload.txt", timeoutMs: 5_000 })).found).toBe(true);

		// snapshot: full has the nav, scoped to #login does not but keeps breadcrumb
		const full = await mgr.a11ySnapshot();
		expect(full).toContain('link "Home"');
		const scoped = await mgr.a11ySnapshot("#login");
		expect(scoped).toContain('button "Sign in"');
		expect(scoped).not.toContain('link "Home"');
		expect(scoped.split("\n")[0]).toContain("RootWebArea");

		// page text + screenshot
		expect(await mgr.getPageText()).toContain("clicked:ola pit");
		expect((await mgr.screenshot({})).length).toBeGreaterThan(1_000);

		// network buffer + response body (request fired AFTER attach)
		await mgr.evaluate("fetch('/api')");
		let entry: { requestId: string; status?: number } | undefined;
		for (let i = 0; i < 25 && entry?.status === undefined; i++) {
			entry = mgr.readNetwork({}).find((e) => e.url.endsWith("/api"));
			if (entry?.status === undefined) await new Promise((r) => setTimeout(r, 200));
		}
		expect(entry).toBeDefined();
		// The body is only retrievable after Network.loadingFinished, which has no
		// hook in the buffer — retry until Chrome has it.
		let body: { body: string } | undefined;
		for (let i = 0; i < 25 && !body; i++) {
			try {
				body = await mgr.getResponseBody((entry as { requestId: string }).requestId);
			} catch {
				await new Promise((r) => setTimeout(r, 200));
			}
		}
		expect(body?.body).toContain("pit-body-ok");
	});

	// Regression: a freshly opened tab drops Input.dispatch* / insertText until its
	// compositor produces a frame. Open a NEW tab (cold renderer) and assert each
	// synthetic input lands — fill sets the value, the keydown listener fires, and
	// the click handler runs. Before the ensureInputReady gate this failed ~75% of
	// fresh launches (value set by evaluate, but key/click silently swallowed).
	it("synthetic input lands on a freshly opened (cold) tab", { timeout: 60_000 }, async () => {
		await mgr.navigate({ url: `http://127.0.0.1:${HTTP_PORT}/`, newTab: true });
		expect((await mgr.waitFor({ selector: "#login", timeoutMs: 15_000 })).found).toBe(true);

		await mgr.fill("#q", "cold start");
		expect((await mgr.evaluate("document.getElementById('q').value")).value).toBe("cold start");

		await mgr.pressKey("Enter");
		expect((await mgr.waitFor({ text: "key:Enter", timeoutMs: 5_000 })).found).toBe(true);

		await mgr.click("#b");
		expect((await mgr.waitFor({ text: "clicked:cold start", timeoutMs: 5_000 })).found).toBe(true);
	});

	// Full lifecycle: open a tab, interact, close it, and confirm the manager is
	// back to a clean state -- the closed tab is gone from listPages, nothing is
	// selected, and a fresh navigate re-opens a working tab. This is the "finish
	// the browser task and go back to the chat" path the agent must be able to run.
	it("closePage closes the tab and a fresh navigate reopens cleanly", { timeout: 60_000 }, async () => {
		// open a new tab and interact so it is a live, selected page
		await mgr.navigate({ url: `http://127.0.0.1:${HTTP_PORT}/`, newTab: true });
		expect((await mgr.waitFor({ selector: "#login", timeoutMs: 15_000 })).found).toBe(true);
		await mgr.fill("#q", "lifecycle");
		const openedId = mgr.selectedPageId();
		expect(openedId).toBeTruthy();
		expect((await mgr.listPages()).map((p) => p.id)).toContain(openedId);

		// close it -> gone from listPages, nothing selected
		const closed = await mgr.closePage();
		expect(closed.closedId).toBe(openedId);
		// Chrome destroys the target async; poll until listPages no longer shows it.
		let stillThere = true;
		for (let i = 0; i < 25 && stillThere; i++) {
			stillThere = (await mgr.listPages()).some((p) => p.id === openedId);
			if (stillThere) await new Promise((r) => setTimeout(r, 200));
		}
		expect(stillThere).toBe(false);
		expect(mgr.selectedPageId()).toBeUndefined();

		// a fresh navigate reopens a working tab (auto new tab since none selected)
		await mgr.navigate({ url: `http://127.0.0.1:${HTTP_PORT}/` });
		expect((await mgr.waitFor({ selector: "#login", timeoutMs: 15_000 })).found).toBe(true);
		const reopenedId = mgr.selectedPageId();
		expect(reopenedId).toBeTruthy();
		expect(reopenedId).not.toBe(openedId);
		expect(await mgr.getPageText()).toContain("hover me");

		// clean up the reopened tab too
		await mgr.closePage();
	});
});
