import { homedir } from "node:os";
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
	/** Simulated context usage (null = unknown / fresh session). */
	contextUsage?: { tokens: number; percent: number; contextWindow: number; estimated?: boolean } | null;
	/** Providers visible to the registry (provider prefix shows when > 1). */
	providerCount?: number;
	/** Mark the model as a reasoning model with this thinking level. */
	thinkingLevel?: string;
	/** Session cwd (defaults to a plain project path). */
	cwd?: string;
	/** Git branch reported by the footer data provider. */
	branch?: string;
}

function makeFooter({
	permissions = null,
	autoCompact = false,
	extra,
	usingOAuth = false,
	cost = 0,
	contextUsage = null,
	providerCount = 1,
	thinkingLevel,
	cwd = "C:/x",
	branch = "",
}: MakeFooterOptions = {}): FooterComponent {
	// A subscription tag needs a truthy model for isUsingOAuth(state.model).
	const needsModel = usingOAuth || providerCount > 1 || thinkingLevel !== undefined;
	const model = needsModel
		? { id: "test-model", provider: "anthropic", contextWindow: 200000, reasoning: thinkingLevel !== undefined }
		: undefined;
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
			thinkingLevel: thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => "",
			getCwd: () => cwd,
		},
		getContextUsage: () => contextUsage,
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
		getGitBranch: () => branch,
		getRepoDir: () => null,
		getExtensionStatuses: () => statuses,
		getStatusVersion: () => 0,
		getAvailableProviderCount: () => providerCount,
		onBranchChange: () => () => {},
	};

	const footer = new FooterComponent(session, footerData);
	footer.setAutoCompactEnabled(autoCompact);
	return footer;
}

beforeAll(() => {
	initTheme("dark");
});

it("shows the permission mode but no compact noise when auto-compact is on", () => {
	// Auto-compact is the default-on state, so it must NOT render a permanent
	// indicator — only the permission mode shows.
	const footer = makeFooter({ permissions: "auto", autoCompact: true });
	const lines = footer.render(80).map(stripAnsi);
	expect(lines.length).toBe(2);
	expect(lines[1]).toContain("auto"); // permission mode
	expect(lines[1]).not.toContain("compact"); // default-on state is silent
	expect(lines.some((l) => l.startsWith("permissions:"))).toBe(false);
});

it("flags no-compact (warning) only when auto-compact is OFF — the abnormal state", () => {
	const footer = makeFooter({
		permissions: "plan",
		autoCompact: false,
		extra: new Map([["whatsapp", "whatsapp: 3"]]),
	});
	const lines = footer.render(80).map(stripAnsi);
	expect(lines.length).toBe(3);
	expect(lines[1]).toContain("plan");
	expect(lines[1]).toContain("no-compact");
	expect(lines[2]).toContain("whatsapp: 3");
});

it("never renders a cost segment on the metrics line, even when real cost accrued", () => {
	// Cost is intentionally kept off the footer base UI. It is still tracked
	// internally (stats panel) — just not surfaced on the metrics line.
	for (const opts of [{ usingOAuth: true, cost: 1.5 }, { usingOAuth: false, cost: 1.5 }, { cost: 0.0004 }]) {
		const footer = makeFooter(opts);
		const lines = footer.render(80).map(stripAnsi);
		expect(lines[1]).not.toContain("$");
		expect(lines[1]).not.toContain("(sub)");
	}
});

it("renders a dim capacity-only CTX on a pristine session (no 0.0% noise)", () => {
	const footer = makeFooter({ usingOAuth: true });
	const lines = footer.render(80).map(stripAnsi);
	expect(lines[1]).toContain("CTX 200k");
	expect(lines[1]).not.toContain("%");
	expect(lines[1]).not.toContain("0/200k");
});

it("renders whole-percent + counts once the context has usage (no meter bar)", () => {
	const footer = makeFooter({
		usingOAuth: true,
		contextUsage: { tokens: 46800, percent: 23.4, contextWindow: 200000 },
	});
	const lines = footer.render(80).map(stripAnsi);
	// Color carries the state; the old 5-cell bar could only disagree with the
	// precise percent next to it, so it is gone. No decimals in a gauge.
	expect(lines[1]).toContain("CTX 23% · 47k/200k");
	expect(lines[1]).not.toContain("▰");
});

it("marks a post-compaction structural estimate with a ~ (never reads as an exact figure)", () => {
	const footer = makeFooter({
		usingOAuth: true,
		contextUsage: { tokens: 12000, percent: 6, contextWindow: 200000, estimated: true },
	});
	const lines = footer.render(80).map(stripAnsi);
	expect(lines[1]).toContain("CTX ~6% · ~12k/200k");
});

it("never reads untouched: sub-1% usage rounds up to 1%, tiny usage shows <1%", () => {
	const footer = makeFooter({
		usingOAuth: true,
		contextUsage: { tokens: 1500, percent: 0.8, contextWindow: 200000 },
	});
	const lines = footer.render(80).map(stripAnsi);
	expect(lines[1]).toContain("CTX 1% · 1.5k/200k");

	const tiny = makeFooter({
		usingOAuth: true,
		contextUsage: { tokens: 600, percent: 0.3, contextWindow: 200000 },
	});
	const tinyLines = tiny.render(80).map(stripAnsi);
	expect(tinyLines[1]).toContain("CTX <1% · 600/200k");
});

it("suppresses a lone ~ cwd label in the home dir with no project context", () => {
	const footer = makeFooter({ cwd: homedir() });
	const lines = footer.render(80).map(stripAnsi);
	// No branch, no session name: the identity line must not open with a bare
	// "~" — the right side (model) owns the line alone.
	expect(lines[0].trimStart().startsWith("~")).toBe(false);
});

it("keeps the ~ cwd label when a branch gives it context", () => {
	const footer = makeFooter({ cwd: homedir(), branch: "main" });
	const lines = footer.render(80).map(stripAnsi);
	expect(lines[0]).toContain("~ (main)");
});

it("shows the provider muted without parentheses when several providers are available", () => {
	const footer = makeFooter({ providerCount: 2 });
	const lines = footer.render(80).map(stripAnsi);
	expect(lines[0]).toContain("anthropic · test-model");
	expect(lines[0]).not.toContain("(anthropic)");
});

it("renders the thinking level as a ✦ chip on reasoning models", () => {
	const footer = makeFooter({ thinkingLevel: "high" });
	const lines = footer.render(80).map(stripAnsi);
	expect(lines[0]).toContain("test-model • ✦ high");
});

it("keeps the ✦ chip intact on a narrow line, truncating the model id instead", () => {
	// At a tight width the right cluster must shrink the MODEL id (with ellipsis),
	// never the protected `✦ high` chip — otherwise it clips to a dangling `✦`.
	const footer = makeFooter({ thinkingLevel: "high", providerCount: 2 });
	const lines = footer.render(30).map(stripAnsi);
	expect(lines[0]).toContain("✦ high");
	expect(lines[0]).not.toMatch(/✦$/); // no orphaned glyph at the line end
	expect(lines[0]).toContain("…"); // the model id absorbed the squeeze
});

it("dims uncolored extension statuses but passes pre-colorized ones through", () => {
	const colored = "[32mready[39m";
	const footer = makeFooter({
		extra: new Map([
			["a", "plain status"],
			["b", colored],
		]),
	});
	const lines = footer.render(80);
	const statusLine = lines[lines.length - 1];
	// The plain status gained SOME color wrapper; the colored one is untouched.
	expect(stripAnsi(statusLine)).toContain("plain status");
	expect(statusLine).toContain(colored);
	expect(statusLine.indexOf("plain status")).toBeGreaterThan(statusLine.indexOf("["));
});
