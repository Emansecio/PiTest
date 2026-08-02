/**
 * Regression: the chrome feature (chrome_devtools_* + preview) is turn-scoped.
 * Normal sessions should not pay its schemas; the browser routing extension
 * activates a relevant subset from the user's prompt.
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

	it("keeps the chrome family off the default surface", async () => {
		const session = await createDefaultSession();
		const active = session.getActiveToolNames();
		expect(active.some((name) => name.startsWith("chrome_devtools"))).toBe(false);
		expect(active).not.toContain("preview");
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
