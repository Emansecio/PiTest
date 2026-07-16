/**
 * Adaptive cache retention wiring in the SDK streamFn (perf audit §3.1).
 *
 * createAgentSession's streamFn passes an explicit cacheRetention to
 * streamSimple on every request: "long" for the default (interactive) session,
 * or the session-level option when the embedder/app passes one — main.ts passes
 * "short" for one-shot print/JSON/RPC runs. The faux provider captures the
 * options it receives, so this exercises the real streamFn end to end without
 * any network. (PIT_CACHE_RETENTION env precedence is resolved deeper, in the
 * provider layer — covered by packages/ai/test/cache-retention.test.ts.)
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("SDK session cache retention", () => {
	let tempDir: string;
	let agentDir: string;
	let faux: FauxProviderRegistration;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-cache-retention-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function promptAndCaptureRetention(sessionCacheRetention?: "none" | "short" | "long") {
		const model = faux.getModel();
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const seenRetentions: Array<string | undefined> = [];
		faux.setResponses([
			(_context, options) => {
				seenRetentions.push(options?.cacheRetention);
				return fauxAssistantMessage("ok");
			},
		]);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			settingsManager,
			sessionManager,
			authStorage,
			resourceLoader,
			cacheRetention: sessionCacheRetention,
		});
		try {
			await session.prompt("hello");
		} finally {
			await session.dispose();
		}
		return seenRetentions;
	}

	it("defaults to long retention for a plain (interactive-style) session", async () => {
		expect(await promptAndCaptureRetention()).toEqual(["long"]);
	});

	it("honors the session-level option (one-shot runs pass short)", async () => {
		expect(await promptAndCaptureRetention("short")).toEqual(["short"]);
	});
});
