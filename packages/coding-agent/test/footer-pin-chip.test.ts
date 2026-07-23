import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import type { PinItem } from "../src/core/pins.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

beforeAll(() => {
	initTheme("dark");
});

function makeSession(pins: readonly PinItem[]): AgentSession {
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
		pins: { list: () => pins },
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

const fact: PinItem = { id: "p1", kind: "fact", text: "never touch CHANGELOG.md", createdBy: "user" };
const file: PinItem = { id: "p2", kind: "file", canonicalPath: "/tmp/x.ts", displayPath: "x.ts", createdBy: "user" };

describe("FooterComponent pin chip", () => {
	it("omits the pin segment when nothing is pinned", () => {
		const footer = new FooterComponent(makeSession([]), makeFooterData());
		const metrics = stripAnsi(footer.render(120)[1]);
		expect(metrics).not.toContain("pin:");
	});

	it("shows pin:N on the metrics line, counting facts and files together", () => {
		const footer = new FooterComponent(makeSession([fact, file]), makeFooterData());
		const metrics = stripAnsi(footer.render(120)[1]);
		expect(metrics).toContain("pin:2");
	});

	it("updates the count across renders as pins change (live repaint source)", () => {
		let items: PinItem[] = [fact];
		const session = makeSession([]);
		(session as unknown as { pins: { list: () => PinItem[] } }).pins = { list: () => items };
		const footer = new FooterComponent(session, makeFooterData());
		expect(stripAnsi(footer.render(120)[1])).toContain("pin:1");
		items = [fact, file];
		expect(stripAnsi(footer.render(120)[1])).toContain("pin:2");
	});
});
