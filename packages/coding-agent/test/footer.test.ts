import { beforeAll, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

interface MakeFooterOptions {
	permissions?: string | null;
	autoCompact?: boolean;
	extra?: Map<string, string>;
}

function makeFooter({ permissions = null, autoCompact = false, extra }: MakeFooterOptions = {}): FooterComponent {
	const session: AgentSession = {
		state: {
			model: undefined,
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => [],
			getSessionName: () => "",
			getCwd: () => "C:/x",
		},
		getContextUsage: () => null,
		goalStatusLine: () => null,
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as AgentSession;

	const statuses = new Map<string, string>();
	if (permissions != null) {
		statuses.set("permissions", `permissions: ${permissions}`);
	}
	if (extra) {
		for (const [k, v] of extra) {
			statuses.set(k, v);
		}
	}

	const footerData: ReadonlyFooterDataProvider = {
		getGitBranch: () => "",
		getExtensionStatuses: () => statuses,
		getStatusVersion: () => 0,
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};

	const footer = new FooterComponent(session, footerData);
	footer.setAutoCompactEnabled(autoCompact);
	return footer;
}

beforeAll(() => {
	initTheme("dark");
});

it("shows permission mode + compact glyph on metrics line, not a 3rd line", () => {
	const footer = makeFooter({ permissions: "auto", autoCompact: true });
	const lines = footer.render(80).map(stripAnsi);
	expect(lines.length).toBe(2);
	expect(lines[1]).toContain("auto");
	expect(lines[1]).toContain("⟳");
	expect(lines.some((l) => l.startsWith("permissions:"))).toBe(false);
});

it("keeps a 3rd line when another extension status exists; compact off hides glyph", () => {
	const footer = makeFooter({
		permissions: "plan",
		autoCompact: false,
		extra: new Map([["whatsapp", "whatsapp: 3"]]),
	});
	const lines = footer.render(80).map(stripAnsi);
	expect(lines.length).toBe(3);
	expect(lines[1]).toContain("plan");
	expect(lines[1]).not.toContain("⟳");
	expect(lines[2]).toContain("whatsapp: 3");
});
