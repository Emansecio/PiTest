/**
 * P8b — the dense `gear:<role>` footer chip, shown only while the model gearbox
 * holds a downshifted role. Mirrors footer-pin-chip.test.ts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

beforeAll(() => initTheme("dark"));

function makeSession(): AgentSession {
	return {
		state: {
			model: { id: "kimi-k2.6", provider: "opencode", contextWindow: 200_000, reasoning: true },
			thinkingLevel: "medium",
		},
		sessionManager: {
			getEntries: () => [],
			getSessionName: () => "",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 0, tokens: 0 }),
		goalIsDriving: () => false,
		goalStatusLine: () => "",
		modelRegistry: { isUsingOAuth: () => false },
		orchestration: "solo",
		pins: { list: () => [] },
	} as unknown as AgentSession;
}

function makeFooterData(): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => null,
		getGitDiffStats: () => null,
		getGitDiffVersion: () => 0,
		getRepoDir: () => null,
		getExtensionStatuses: () => new Map(),
		getStatusVersion: () => 0,
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
		onWorkingTreeChange: () => () => {},
	} as unknown as ReadonlyFooterDataProvider;
}

describe("FooterComponent gearbox chip", () => {
	it("omits the gear chip by default", () => {
		const footer = new FooterComponent(makeSession(), makeFooterData());
		expect(stripAnsi(footer.render(120)[1])).not.toContain("gear:");
	});

	it("shows gear:smol on the metrics line while downshifted", () => {
		const footer = new FooterComponent(makeSession(), makeFooterData());
		footer.setGearboxRole("smol");
		expect(stripAnsi(footer.render(120)[1])).toContain("gear:smol");
	});

	it("clears the chip on upshift (setGearboxRole(null))", () => {
		const footer = new FooterComponent(makeSession(), makeFooterData());
		footer.setGearboxRole("smol");
		expect(stripAnsi(footer.render(120)[1])).toContain("gear:smol");
		footer.setGearboxRole(null);
		expect(stripAnsi(footer.render(120)[1])).not.toContain("gear:");
	});
});
