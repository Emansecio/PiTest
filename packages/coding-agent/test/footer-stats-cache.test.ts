import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

function createActiveSession(opts?: {
	thinkingLevel?: string;
	reasoning?: boolean;
	modelId?: string;
	cwd?: string;
	contextPercent?: number;
}): AgentSession {
	const session = {
		state: {
			model: {
				id: opts?.modelId ?? "test-model",
				provider: "test",
				contextWindow: 200_000,
				reasoning: opts?.reasoning ?? false,
			},
			thinkingLevel: opts?.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => [],
			getSessionName: () => "",
			getCwd: () => opts?.cwd ?? "/tmp/project",
		},
		// A user message makes this an active session, so the footer renders
		// the full context metrics rather than the pristine capacity-only state.
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
		getContextUsage: () => ({ contextWindow: 200_000, percent: opts?.contextPercent ?? 12.3, tokens: 24_600 }),
		modelRegistry: { isUsingOAuth: () => false },
		goalIsDriving: () => false,
		goalStatusLine: () => "",
	};
	return session as unknown as AgentSession;
}

function createFooterData(providerCount = 1): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => null,
		getGitDiffStats: () => null,
		getGitDiffVersion: () => 0,
		getRepoDir: () => null,
		getExtensionStatuses: () => new Map<string, string>(),
		getStatusVersion: () => 0,
		getAvailableProviderCount: () => providerCount,
		onBranchChange: () => () => {},
		onWorkingTreeChange: () => () => {},
	};
}

describe("FooterComponent context color thresholds", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	// The ANSI opening escape `theme.fg(color, …)` emits before the wrapped text.
	const escapeOf = (color: "accent" | "warning" | "error"): string => {
		const wrapped = theme.fg(color, "_");
		return wrapped.slice(0, wrapped.indexOf("_"));
	};

	// Returns the raw (ANSI-bearing) escape run immediately before the percent
	// token — the state color of the gauge (the CTX label itself is fixed dim).
	const ctxPercentEscape = (contextPercent: number): string => {
		const session = createActiveSession({ contextPercent });
		const footer = new FooterComponent(session, createFooterData());
		const line = footer.render(200)[1];
		const pctIndex = line.indexOf(`${Math.round(contextPercent)}%`);
		const match = line.slice(0, pctIndex).match(/(?:\x1b\[[0-9;]+m)+$/);
		return match ? match[0] : "";
	};

	it("uses calm accent below 70%, warning above 70%, error above 90%", () => {
		const low = ctxPercentEscape(50);
		const warn = ctxPercentEscape(80);
		const err = ctxPercentEscape(95);

		// Each is wrapped in some SGR escape...
		const sgr = /\x1b\[[0-9;]+m/;
		expect(sgr.test(low)).toBe(true);
		expect(sgr.test(warn)).toBe(true);
		expect(sgr.test(err)).toBe(true);

		// ...and the three thresholds pick distinct, correct palette colors.
		expect(low.endsWith(escapeOf("accent"))).toBe(true);
		expect(warn.endsWith(escapeOf("warning"))).toBe(true);
		expect(err.endsWith(escapeOf("error"))).toBe(true);
	});

	it("treats the 70 and 90 boundaries as inclusive of the lower band (strict >)", () => {
		// 70.0 is NOT > 70 → still accent; 90.0 is NOT > 90 → still warning.
		expect(ctxPercentEscape(70).endsWith(escapeOf("accent"))).toBe(true);
		expect(ctxPercentEscape(90).endsWith(escapeOf("warning"))).toBe(true);
	});
});

describe("FooterComponent identity line", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("places the model name on the identity line (line 0), not the metrics line", () => {
		const session = createActiveSession({ modelId: "test-model-x" });
		const footer = new FooterComponent(session, createFooterData());

		const [identity, metrics] = footer.render(200);
		expect(identity).toContain("test-model-x");
		expect(metrics).not.toContain("test-model-x");
	});

	it("tints the thinking-level token with the matching theme palette", () => {
		// Theme has thinkingHigh="#b294bb" (dark) — we just check that the
		// rendered line embeds the ANSI escape sequence the colorizer would
		// produce. We don't hardcode the exact byte sequence since it depends
		// on the theme's color-mode runtime; instead we assert (a) the level
		// label "high" is present and (b) it is wrapped in *some* SGR escape
		// (the un-themed dark theme initializer above selects 24-bit).
		const session = createActiveSession({
			modelId: "gpt-5",
			reasoning: true,
			thinkingLevel: "high",
		});
		const footer = new FooterComponent(session, createFooterData());

		const identity = footer.render(200)[0];
		expect(identity).toContain("High");
		// The level token must be inside an ANSI SGR (\x1b[...m) sequence
		// distinct from the muted/dim wrappers used elsewhere on the line.
		const idxHigh = identity.indexOf("High");
		const slice = identity.slice(Math.max(0, idxHigh - 32), idxHigh);
		expect(/\x1b\[[0-9;]+m/.test(slice)).toBe(true);
	});

	it("falls back to plain text when the model has no reasoning support", () => {
		const session = createActiveSession({
			modelId: "tiny",
			reasoning: false,
			thinkingLevel: "high",
		});
		const footer = new FooterComponent(session, createFooterData());

		const identity = footer.render(200)[0];
		expect(identity).toContain("tiny");
		// Non-reasoning models should NOT show a thinking-level token.
		expect(identity).not.toContain("High");
		expect(identity).not.toContain("Thinking off");
	});

	it("normalizes an unknown thinkingLevel value to 'off' instead of throwing", () => {
		const session = createActiveSession({
			modelId: "tiny",
			reasoning: true,
			thinkingLevel: "bogus",
		});
		const footer = new FooterComponent(session, createFooterData());

		const identity = footer.render(200)[0];
		expect(identity).toContain("tiny");
		// Unknown levels normalize to off — chip stays hidden.
		expect(identity).not.toContain("Thinking off");
	});
});
