import { getRuntimeDiagnostics, recordDiagnostic, resetRuntimeDiagnostics } from "@pit/ai";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

beforeAll(() => {
	initTheme("dark");
});

function makeSession(): AgentSession {
	return {
		state: {
			model: { id: "glm-4", provider: "opencode", contextWindow: 200_000, reasoning: true },
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
	};
}

describe("FooterComponent overthink guard counter", () => {
	beforeEach(() => {
		resetRuntimeDiagnostics();
	});

	it("omits the overthink segment when the guard has not fired", () => {
		const footer = new FooterComponent(makeSession(), makeFooterData());
		const metrics = stripAnsi(footer.render(120)[1]);
		expect(metrics).not.toContain("overthink");
	});

	it("shows overthink ×N on the metrics line after guard fires", () => {
		recordDiagnostic({
			category: "stream.overthink-guard",
			level: "info",
			source: "agent-loop.streamAssistantResponse",
			context: { attempt: 1, note: "tokens~1200 threshold~1000" },
		});
		recordDiagnostic({
			category: "stream.overthink-guard",
			level: "info",
			source: "agent-loop.streamAssistantResponse",
			context: { attempt: 2, note: "tokens~1300 threshold~1000" },
		});
		expect(getRuntimeDiagnostics().counters["stream.overthink-guard"]?.count).toBe(2);

		const footer = new FooterComponent(makeSession(), makeFooterData());
		const metrics = stripAnsi(footer.render(120)[1]);
		expect(metrics).toContain("overthink ×2");
	});
});
