import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

interface MutableEntries {
	push: (input: number, output: number, cost: number) => void;
}

function makeAssistantEntry(input: number, output: number, cost: number) {
	return {
		type: "message" as const,
		message: {
			role: "assistant" as const,
			usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
		},
	};
}

/**
 * Build a session+entries pair where the test owns the entries array.
 * The session's `getEntries` returns the live array reference so mutations
 * between renders are visible to the footer.
 */
function createMutableSession(opts?: {
	thinkingLevel?: string;
	reasoning?: boolean;
	modelId?: string;
	cwd?: string;
	contextPercent?: number;
}) {
	const entries: ReturnType<typeof makeAssistantEntry>[] = [];
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
			getEntries: () => entries,
			getSessionName: () => "",
			getCwd: () => opts?.cwd ?? "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: opts?.contextPercent ?? 12.3, tokens: 24_600 }),
		modelRegistry: { isUsingOAuth: () => false },
		goalStatusLine: () => "",
	};
	const ctrl: MutableEntries = {
		push: (input, output, cost) => {
			entries.push(makeAssistantEntry(input, output, cost));
		},
	};
	return {
		session: session as unknown as AgentSession,
		entries,
		ctrl,
		// Cheap accessor for tests that want to splice/replace entries directly.
		replaceEntries: (next: ReturnType<typeof makeAssistantEntry>[]) => {
			entries.length = 0;
			entries.push(...next);
		},
	};
}

function createFooterData(providerCount = 1): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map<string, string>(),
		getStatusVersion: () => 0,
		getAvailableProviderCount: () => providerCount,
		onBranchChange: () => () => {},
	};
}

function getMetricsLine(footer: FooterComponent): string {
	// Layout: line 0 = identity, line 1 = metrics, line 2 = (optional) ext statuses
	return footer.render(200)[1];
}

describe("FooterComponent stats cache", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("accumulates totals across renders when entries grow", () => {
		const { session, ctrl } = createMutableSession();
		const footer = new FooterComponent(session, createFooterData());

		ctrl.push(1000, 500, 0.01);
		const first = getMetricsLine(footer);
		expect(first).toContain("↑1.0k");
		expect(first).toContain("↓500");
		expect(first).toContain("$0.010");

		ctrl.push(2000, 1500, 0.05);
		const second = getMetricsLine(footer);
		expect(second).toContain("↑3.0k");
		expect(second).toContain("↓2.0k");
		expect(second).toContain("$0.060");
	});

	it("only walks the new tail on subsequent renders (incremental cache)", () => {
		const { session, entries, ctrl } = createMutableSession();
		const footer = new FooterComponent(session, createFooterData());

		ctrl.push(100, 50, 0.001);
		getMetricsLine(footer); // primes the cache

		// Swap the existing entry's usage to a different value. If the footer
		// were rescanning from scratch each render, it would pick up the new
		// numbers. With the tail-incremental cache it should NOT — the
		// already-counted entry is frozen in the cumulative total.
		entries[0].message.usage.input = 9999;
		entries[0].message.usage.output = 9999;
		entries[0].message.usage.cost.total = 9.999;

		const second = getMetricsLine(footer);
		expect(second).toContain("↑100");
		expect(second).toContain("↓50");
		expect(second).toContain("$0.001");
	});

	it("resets the cache when entries shrink (fork / clear / compaction replace)", () => {
		const { session, entries, ctrl } = createMutableSession();
		const footer = new FooterComponent(session, createFooterData());

		ctrl.push(1000, 500, 0.01);
		ctrl.push(2000, 1500, 0.05);
		getMetricsLine(footer); // prime: totals = 3000/2000/$0.06

		// Simulate a fork that dropped the second message.
		entries.pop();

		const after = getMetricsLine(footer);
		expect(after).toContain("↑1.0k");
		expect(after).toContain("↓500");
		expect(after).toContain("$0.010");
	});

	it("resets the cache on invalidate()", () => {
		const { session, entries, ctrl } = createMutableSession();
		const footer = new FooterComponent(session, createFooterData());

		ctrl.push(1000, 500, 0.01);
		getMetricsLine(footer);

		// Mutate in-place to a smaller value, then invalidate. After
		// invalidate the cache should rescan from index 0 and pick up the new
		// numbers.
		entries[0].message.usage.input = 42;
		entries[0].message.usage.output = 7;
		entries[0].message.usage.cost.total = 0.002;
		footer.invalidate();

		const after = getMetricsLine(footer);
		expect(after).toContain("↑42");
		expect(after).toContain("↓7");
		expect(after).toContain("$0.002");
	});

	it("resets the cache on setSession() to a different session reference", () => {
		const a = createMutableSession();
		const b = createMutableSession();
		const footer = new FooterComponent(a.session, createFooterData());

		a.ctrl.push(1000, 500, 0.01);
		getMetricsLine(footer); // primes against session A

		b.ctrl.push(42, 7, 0.002);
		footer.setSession(b.session);

		const after = getMetricsLine(footer);
		expect(after).toContain("↑42");
		expect(after).toContain("↓7");
	});

	it("handles assistant entries with zero usage without crashing", () => {
		const { session, ctrl } = createMutableSession();
		const footer = new FooterComponent(session, createFooterData());

		ctrl.push(0, 0, 0);
		const line = getMetricsLine(footer);
		// With everything zero the metric arrows drop out; only the ctx headline remains.
		expect(line).not.toContain("↑");
		expect(line).not.toContain("↓");
		expect(line).toContain("ctx 12.3% · 25k/200k");
	});
});

describe("FooterComponent context color thresholds", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	// The ANSI opening escape `theme.fg(color, …)` emits before the wrapped text.
	const escapeOf = (color: "muted" | "warning" | "error"): string => {
		const wrapped = theme.fg(color, "_");
		return wrapped.slice(0, wrapped.indexOf("_"));
	};

	// Returns the raw (ANSI-bearing) prefix of the metrics line up to the `ctx`
	// token — i.e. the color escape the context headline was wrapped in.
	const ctxPrefix = (contextPercent: number): string => {
		const { session, ctrl } = createMutableSession({ contextPercent });
		const footer = new FooterComponent(session, createFooterData());
		ctrl.push(100, 50, 0.001);
		const line = footer.render(200)[1];
		return line.slice(0, line.indexOf("ctx"));
	};

	it("uses muted below 70%, warning above 70%, error above 90%", () => {
		const low = ctxPrefix(50);
		const warn = ctxPrefix(80);
		const err = ctxPrefix(95);

		// Each is wrapped in some SGR escape...
		const sgr = /\x1b\[[0-9;]+m/;
		expect(sgr.test(low)).toBe(true);
		expect(sgr.test(warn)).toBe(true);
		expect(sgr.test(err)).toBe(true);

		// ...and the three thresholds pick distinct, correct palette colors.
		expect(low.endsWith(escapeOf("muted"))).toBe(true);
		expect(warn.endsWith(escapeOf("warning"))).toBe(true);
		expect(err.endsWith(escapeOf("error"))).toBe(true);
	});

	it("treats the 70 and 90 boundaries as inclusive of the lower band (strict >)", () => {
		// 70.0 is NOT > 70 → still muted; 90.0 is NOT > 90 → still warning.
		expect(ctxPrefix(70).endsWith(escapeOf("muted"))).toBe(true);
		expect(ctxPrefix(90).endsWith(escapeOf("warning"))).toBe(true);
	});
});

describe("FooterComponent identity line", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("places the model name on the identity line (line 0), not the metrics line", () => {
		const { session, ctrl } = createMutableSession({ modelId: "test-model-x" });
		const footer = new FooterComponent(session, createFooterData());
		ctrl.push(100, 50, 0.001);

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
		const { session, ctrl } = createMutableSession({
			modelId: "gpt-5",
			reasoning: true,
			thinkingLevel: "high",
		});
		const footer = new FooterComponent(session, createFooterData());
		ctrl.push(100, 50, 0.001);

		const identity = footer.render(200)[0];
		expect(identity).toContain("high");
		// The level token must be inside an ANSI SGR (\x1b[...m) sequence
		// distinct from the muted/dim wrappers used elsewhere on the line.
		const idxHigh = identity.indexOf("high");
		const slice = identity.slice(Math.max(0, idxHigh - 32), idxHigh);
		expect(/\x1b\[[0-9;]+m/.test(slice)).toBe(true);
	});

	it("falls back to plain text when the model has no reasoning support", () => {
		const { session, ctrl } = createMutableSession({
			modelId: "tiny",
			reasoning: false,
			thinkingLevel: "high",
		});
		const footer = new FooterComponent(session, createFooterData());
		ctrl.push(100, 50, 0.001);

		const identity = footer.render(200)[0];
		expect(identity).toContain("tiny");
		// Non-reasoning models should NOT show a thinking-level token.
		expect(identity).not.toContain("high");
		expect(identity).not.toContain("thinking off");
	});

	it("normalizes an unknown thinkingLevel value to 'off' instead of throwing", () => {
		const { session, ctrl } = createMutableSession({
			modelId: "tiny",
			reasoning: true,
			thinkingLevel: "bogus",
		});
		const footer = new FooterComponent(session, createFooterData());
		ctrl.push(100, 50, 0.001);

		const identity = footer.render(200)[0];
		expect(identity).toContain("tiny");
		expect(identity).toContain("thinking off");
	});
});
