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
	/** Simulate a subscription (OAuth) model so the `(sub)` tag can appear. */
	usingOAuth?: boolean;
	/** Accrued cost to inject via a single assistant entry. */
	cost?: number;
}

function makeFooter({
	permissions = null,
	autoCompact = false,
	extra,
	usingOAuth = false,
	cost = 0,
}: MakeFooterOptions = {}): FooterComponent {
	// A subscription tag needs a truthy model for isUsingOAuth(state.model).
	const model = usingOAuth ? { id: "test-model", provider: "anthropic", contextWindow: 200000 } : undefined;
	const entries =
		cost > 0
			? [
					{
						type: "message",
						message: {
							role: "assistant",
							usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
						},
					},
				]
			: [];
	const session: AgentSession = {
		state: {
			model,
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => "",
			getCwd: () => "C:/x",
		},
		getContextUsage: () => null,
		goalStatusLine: () => null,
		modelRegistry: { isUsingOAuth: () => usingOAuth },
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

it("shows permission mode + compact indicator on metrics line, not a 3rd line", () => {
	// Permission mode "auto" (acceptEdits) and the auto-compact indicator are
	// different axes — they must not collide into a confusing "auto auto". The
	// compact indicator carries its own distinct label.
	const footer = makeFooter({ permissions: "auto", autoCompact: true });
	const lines = footer.render(80).map(stripAnsi);
	expect(lines.length).toBe(2);
	expect(lines[1]).toContain("auto"); // permission mode
	expect(lines[1]).toContain("compact"); // auto-compact indicator
	expect(lines[1]).not.toContain("auto auto");
	expect(lines.some((l) => l.startsWith("permissions:"))).toBe(false);
});

it("keeps a 3rd line when another extension status exists; compact off hides indicator", () => {
	const footer = makeFooter({
		permissions: "plan",
		autoCompact: false,
		extra: new Map([["whatsapp", "whatsapp: 3"]]),
	});
	const lines = footer.render(80).map(stripAnsi);
	expect(lines.length).toBe(3);
	expect(lines[1]).toContain("plan");
	expect(lines[1]).not.toContain("compact");
	expect(lines[2]).toContain("whatsapp: 3");
});

it("hides the cost segment under a subscription when cost rounds to zero", () => {
	const footer = makeFooter({ usingOAuth: true });
	const lines = footer.render(80).map(stripAnsi);
	// No "$0.000 (sub)" noise on a flat subscription plan.
	expect(lines[1]).not.toContain("$");
	expect(lines[1]).not.toContain("(sub)");
});

it("shows the cost segment with the (sub) tag when a subscription accrued real cost", () => {
	const footer = makeFooter({ usingOAuth: true, cost: 1.5 });
	const lines = footer.render(80).map(stripAnsi);
	expect(lines[1]).toContain("$1.500");
	expect(lines[1]).toContain("(sub)");
});

it("hides the cost segment when cost is below the rounding threshold", () => {
	const footer = makeFooter({ cost: 0.0004 });
	const lines = footer.render(80).map(stripAnsi);
	// Would render as "$0.000" — drop it instead of showing a misleading zero.
	expect(lines[1]).not.toContain("$");
});
