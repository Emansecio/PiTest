import { describe, expect, it } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.ts";

describe("getAgentMessagingSettings", () => {
	it("defaults to enabled with the 120s timeout", () => {
		const sm = SettingsManager.inMemory();
		expect(sm.getAgentMessagingSettings()).toEqual({ enabled: true, timeoutMs: 120_000 });
	});

	it("honors an explicit opt-out and a custom timeout", () => {
		const sm = SettingsManager.inMemory({ agentMessaging: { enabled: false, timeoutMs: 5000 } });
		expect(sm.getAgentMessagingSettings()).toEqual({ enabled: false, timeoutMs: 5000 });
	});
});
