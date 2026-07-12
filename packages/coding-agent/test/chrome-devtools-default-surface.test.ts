/**
 * Regression: the chrome feature (chrome_devtools_* + preview) must be on the
 * default active tool surface so any session can drive Chrome without an
 * explicit allowlist. Previously sdk.ts pinned a lean default-active list that
 * silently dropped every gated feature; the default surface now comes from
 * AgentSession._buildRuntime (single source of truth) honoring the gate.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("chrome devtools default active surface", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-chrome-surface-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore Windows handle race */
			}
		}
	});

	async function createDefaultSession() {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		return session;
	}

	it("activates chrome_devtools_* and preview by default so any session can drive Chrome", async () => {
		const session = await createDefaultSession();
		const active = session.getActiveToolNames();
		expect(active).toContain("chrome_devtools_navigate");
		expect(active).toContain("chrome_devtools_close_page");
		expect(active).toContain("chrome_devtools_screenshot");
		expect(active).toContain("chrome_devtools_list_pages");
		expect(active).toContain("preview");
		await session.dispose();
	});

	it("omits the chrome surface when chromeDevtools.enabled is false", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ chromeDevtools: { enabled: false } }));
		const session = await createDefaultSession();
		const active = session.getActiveToolNames();
		expect(active.some((name) => name.startsWith("chrome_devtools"))).toBe(false);
		expect(active).not.toContain("preview");
		await session.dispose();
	});
});
