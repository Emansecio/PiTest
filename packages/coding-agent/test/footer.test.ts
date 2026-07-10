import { homedir } from "node:os";
import { basename, join } from "node:path";
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
	/** Providers visible to the registry (display shows the model id only). */
	providerCount?: number;
	/** Mark the model as a reasoning model with this thinking level. */
	thinkingLevel?: string;
	/** Session cwd (defaults to a plain project path). */
	cwd?: string;
	/** Launcher cwd (defaults to session cwd). */
	launchCwd?: string;
	/** Git branch reported by the footer data provider. */
	branch?: string;
	diffStats?: { files: number; insertions: number; deletions: number } | null;
	/**
	 * Number of user turns to simulate. Defaults to 1 when usage has accrued
	 * (contextUsage provided or cost > 0) and 0 otherwise, so an "active"
	 * session reads as non-pristine and a fresh one as pristine — mirroring the
	 * real product, where the system prompt loads tokens before the first turn
	 * but `messages` stays empty until the user submits.
	 */
	userTurns?: number;
	/** Footer density; tests default to full so extension-status assertions stay valid. */
	density?: "calm" | "full";
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
	launchCwd,
	branch = "",
	diffStats = null,
	userTurns,
	density = "full",
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
	// Accrued usage (contextUsage provided or cost > 0) implies a turn happened,
	// so simulate a user message — otherwise the footer's hasUserTurn() check
	// would (wrongly, for these scenarios) read the session as pristine.
	const turns = userTurns ?? (contextUsage != null || cost > 0 ? 1 : 0);
	const messages = Array.from({ length: turns }, () => ({ role: "user", content: "hi", timestamp: 0 }));
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
		messages,
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
		getGitDiffStats: () => diffStats,
		getGitDiffVersion: () => 0,
		getRepoDir: () => null,
		getExtensionStatuses: () => statuses,
		getStatusVersion: () => 0,
		getAvailableProviderCount: () => providerCount,
		onBranchChange: () => () => {},
		onWorkingTreeChange: () => () => {},
	};

	const footer = new FooterComponent(session, footerData, launchCwd ?? cwd);
	footer.setAutoCompactEnabled(autoCompact);
	footer.setDensity(density);
	return footer;
}

beforeAll(() => {
	initTheme("dark");
});

it("calm density omits extension status wall but keeps no-rails", () => {
	const footer = makeFooter({
		permissions: "no-rails",
		autoCompact: true,
		extra: new Map([["whatsapp", "whatsapp: 3"]]),
		density: "calm",
		contextUsage: { tokens: 1000, percent: 5, contextWindow: 200000 },
	});
	const lines = footer.render(80).map(stripAnsi);
	expect(lines.some((l) => l.includes("NO-RAILS"))).toBe(true);
	expect(lines.some((l) => l.includes("whatsapp"))).toBe(false);
});

it("calm density shows a +N chip for hidden extension statuses", () => {
	const footer = makeFooter({
		permissions: "auto",
		autoCompact: true,
		extra: new Map([
			["whatsapp", "whatsapp: 3"],
			["mcp", "mcp: ready"],
		]),
		density: "calm",
		contextUsage: { tokens: 1000, percent: 5, contextWindow: 200000 },
	});
	const plain = footer.render(80).map(stripAnsi).join("\n");
	expect(plain).toContain("+2");
	expect(plain).not.toContain("whatsapp");
	expect(plain).not.toContain("mcp: ready");
});

it("full density expands extension statuses and omits the +N chip", () => {
	const footer = makeFooter({
		permissions: "auto",
		autoCompact: true,
		extra: new Map([
			["whatsapp", "whatsapp: 3"],
			["mcp", "mcp: ready"],
		]),
		density: "full",
		contextUsage: { tokens: 1000, percent: 5, contextWindow: 200000 },
	});
	const plain = footer.render(80).map(stripAnsi).join("\n");
	expect(plain).toContain("whatsapp");
	expect(plain).not.toContain("+2");
});

it("shows plan mode on metrics but hides default auto mode", () => {
	const footer = makeFooter({
		permissions: "plan",
		autoCompact: true,
		contextUsage: { tokens: 1000, percent: 5, contextWindow: 200000 },
	});
	const lines = footer.render(80).map(stripAnsi);
	expect(lines.some((l) => l.includes("plan"))).toBe(true);
});

it("hides auto on the metrics line when it is the default permission mode", () => {
	const footer = makeFooter({
		permissions: "auto",
		autoCompact: true,
		contextUsage: { tokens: 1000, percent: 5, contextWindow: 200000 },
	});
	const lines = footer.render(80).map(stripAnsi);
	expect(lines.length).toBeGreaterThanOrEqual(2);
	expect(lines.slice(1).join("\n")).not.toContain("auto");
});

it("shows git diff stats in the identity line", () => {
	const footer = makeFooter({
		branch: "main",
		diffStats: { files: 2, insertions: 12, deletions: 3 },
		usingOAuth: true,
	});
	const plain = footer.render(80).map(stripAnsi).join("\n");
	expect(plain).toContain("(main · +12 -3)");
});

it("stacks identity and metrics on narrow terminals", () => {
	const footer = makeFooter({
		permissions: "plan",
		usingOAuth: true,
		autoCompact: true,
		contextUsage: { tokens: 47000, percent: 23, contextWindow: 200000 },
	});
	const lines = footer.render(40).map(stripAnsi);
	expect(lines.length).toBeGreaterThanOrEqual(3);
	expect(lines.some((l) => l.includes("test-model"))).toBe(true);
	expect(lines.some((l) => l.includes("CTX"))).toBe(true);
});

it("stacks CTX and usage on medium-width terminals", () => {
	const footer = makeFooter({
		permissions: "plan",
		usingOAuth: true,
		autoCompact: true,
		cost: 0.01,
		contextUsage: { tokens: 47000, percent: 23, contextWindow: 200000 },
	});
	const lines = footer.render(60).map(stripAnsi);
	const ctxLine = lines.find((line) => line.includes("CTX"));
	expect(ctxLine).toBeDefined();
	expect(ctxLine).not.toMatch(/↑/);
	expect(lines.some((line) => line.includes("↑") || line.includes("plan"))).toBe(true);
});

it("composes CTX and usage on one metrics line when wide enough", () => {
	const footer = makeFooter({
		permissions: "plan",
		autoCompact: true,
		cost: 0.01,
		contextUsage: { tokens: 1000, percent: 5, contextWindow: 200000 },
	});
	const lines = footer.render(80).map(stripAnsi);
	expect(lines.some((line) => line.includes("CTX") && line.includes("plan"))).toBe(true);
});

it("collapses to one line on a pristine idle session with permission mode", () => {
	const footer = makeFooter({ permissions: "auto", autoCompact: true, usingOAuth: true });
	const lines = footer.render(80).map(stripAnsi);
	expect(lines.length).toBe(1);
	expect(lines[0]).toContain("test-model");
	expect(lines[0]).toContain("auto");
	expect(lines.some((l) => l.trim() === "auto")).toBe(false);
});

it("collapses to one line with plan mode on a pristine session", () => {
	const footer = makeFooter({ permissions: "plan", autoCompact: true, usingOAuth: true });
	const lines = footer.render(80).map(stripAnsi);
	expect(lines.length).toBe(1);
	expect(lines[0]).toContain("plan");
});

it("keeps the full two-line footer when context has accrued usage", () => {
	const footer = makeFooter({
		permissions: "auto",
		autoCompact: true,
		usingOAuth: true,
		contextUsage: { tokens: 46800, percent: 23.4, contextWindow: 200000 },
	});
	const lines = footer.render(80).map(stripAnsi);
	expect(lines.length).toBeGreaterThanOrEqual(2);
	expect(lines[1]).toContain("CTX");
	expect(lines[1]).toContain("23% · 47k/200k");
});

it("keeps the no-rails alert on its own line", () => {
	const footer = makeFooter({ permissions: "no-rails", autoCompact: true, usingOAuth: true });
	const lines = footer.render(80).map(stripAnsi);
	expect(lines.length).toBeGreaterThanOrEqual(2);
	expect(lines.some((l) => l.includes("NO-RAILS"))).toBe(true);
});

it("does not collapse when auto-compact is off on an idle session", () => {
	const footer = makeFooter({ permissions: "auto", autoCompact: false, usingOAuth: true });
	const lines = footer.render(80).map(stripAnsi);
	expect(lines.length).toBe(2);
	expect(lines[1]).toContain("no-compact");
});

it("keeps the thinking chip on a narrow collapsed line", () => {
	const footer = makeFooter({ thinkingLevel: "high", permissions: "auto", usingOAuth: true, autoCompact: true });
	const lines = footer.render(30).map(stripAnsi);
	expect(lines.some((line) => line.includes("✦ High"))).toBe(true);
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

it("renders a mini bar, whole-percent, and counts once the context has usage", () => {
	const footer = makeFooter({
		usingOAuth: true,
		contextUsage: { tokens: 46800, percent: 23.4, contextWindow: 200000 },
	});
	const lines = footer.render(80).map(stripAnsi);
	expect(lines[1]).toContain("▰");
	expect(lines[1]).toContain("▱");
	expect(lines[1]).toContain("CTX");
	expect(lines[1]).toContain("23% · 47k/200k");
});

it("marks a post-compaction structural estimate with a ~ (never reads as an exact figure)", () => {
	const footer = makeFooter({
		usingOAuth: true,
		contextUsage: { tokens: 12000, percent: 6, contextWindow: 200000, estimated: true },
	});
	const lines = footer.render(80).map(stripAnsi);
	expect(lines[1]).toContain("~6% · ~12k/200k");
	expect(lines[1]).toContain("▰");
});

it("never reads untouched: sub-1% usage rounds up to 1%, tiny usage shows <1%", () => {
	const footer = makeFooter({
		usingOAuth: true,
		contextUsage: { tokens: 1500, percent: 0.8, contextWindow: 200000 },
	});
	const lines = footer.render(80).map(stripAnsi);
	expect(lines[1]).toContain("1% · 1.5k/200k");
	expect(lines[1]).toContain("▰");

	const tiny = makeFooter({
		usingOAuth: true,
		contextUsage: { tokens: 600, percent: 0.3, contextWindow: 200000 },
	});
	const tinyLines = tiny.render(80).map(stripAnsi);
	expect(tinyLines[1]).toContain("<1% · 600/200k");
	expect(tinyLines[1]).toContain("▰");
});

it("shows the home profile folder in the footer when session cwd is the home directory", () => {
	const home = homedir();
	const footer = makeFooter({ cwd: home });
	const lines = footer.render(80).map(stripAnsi);
	expect(lines[0]).toContain(`${basename(home)} (home)`);
});

it("keeps the home label when a branch gives it context", () => {
	const home = homedir();
	const footer = makeFooter({ cwd: home, branch: "main" });
	const lines = footer.render(80).map(stripAnsi);
	expect(lines[0]).toContain(`${basename(home)} (home) (main)`);
});

it("shows shell cwd when launcher and session cwd diverge", () => {
	const home = homedir();
	const pit = join(home, "pit");
	const footer = makeFooter({ cwd: home, launchCwd: pit });
	const lines = footer.render(80).map(stripAnsi);
	expect(lines[0]).toContain(`${basename(home)} (home)`);
	expect(lines[0]).toContain("shell:");
});

it("shows only the model id, never the provider, even with several providers available", () => {
	const footer = makeFooter({ providerCount: 2 });
	const lines = footer.render(80).map(stripAnsi);
	expect(lines[0]).toContain("test-model");
	expect(lines[0]).not.toContain("anthropic");
});

it("renders the thinking level as a ✦ chip on reasoning models", () => {
	const footer = makeFooter({ thinkingLevel: "high" });
	const lines = footer.render(80).map(stripAnsi);
	expect(lines[0]).toContain("test-model • ✦ High");
});

it("keeps the ✦ chip intact on a narrow line, truncating the model id instead", () => {
	// At a tight width the right cluster must shrink the MODEL id (with ellipsis),
	// never the protected `✦ High` chip — otherwise it clips to a dangling `✦`.
	const footer = makeFooter({
		thinkingLevel: "high",
		providerCount: 2,
		contextUsage: { tokens: 1000, percent: 5, contextWindow: 200000 },
	});
	// Width 16 < model id (10) + chip (9): the id must yield, the chip must not.
	const lines = footer.render(16).map(stripAnsi);
	const modelLine = lines.find((line) => line.includes("✦ High")) ?? lines.join("\n");
	expect(modelLine).toContain("✦ High");
	expect(modelLine).not.toMatch(/✦$/);
	expect(lines.some((line) => line.includes("…"))).toBe(true);
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
