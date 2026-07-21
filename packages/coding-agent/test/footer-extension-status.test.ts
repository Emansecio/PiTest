import { beforeAll, describe, expect, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

beforeAll(() => {
	initTheme("dark");
});

function makeSession(): AgentSession {
	const session = {
		state: {
			model: { id: "test-model", provider: "test", contextWindow: 200_000, reasoning: false },
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => [],
			getSessionName: () => "",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 0 }),
		modelRegistry: { isUsingOAuth: () => false },
		goalIsDriving: () => false,
		goalStatusLine: () => "",
	};
	return session as unknown as AgentSession;
}

function makeFooterData(statuses: Map<string, string>): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => null,
		getGitDiffStats: () => null,
		getGitDiffVersion: () => 0,
		getRepoDir: () => null,
		getExtensionStatuses: () => statuses,
		getStatusVersion: () => 0,
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
		onWorkingTreeChange: () => () => {},
	};
}

function extensionStatusLine(footer: FooterComponent, width = 200): string {
	footer.setDensity("full");
	const lines = footer.render(width);
	expect(lines.length).toBeGreaterThanOrEqual(3);
	return lines[2]!;
}

describe("FooterComponent extension status line", () => {
	test("preserves ANSI colour sequences in extension statuses (does not strip ESC)", () => {
		// Real-world payload shape: a coloured spinner + label, the way the
		// `caveman` extension publishes its working state.
		const statuses = new Map([["caveman", "\x1b[38;5;196m⠠\x1b[38;5;208m⠄\x1b[0m caveman level: FULL"]]);
		const footer = new FooterComponent(makeSession(), makeFooterData(statuses));

		const statusLine = extensionStatusLine(footer);

		// CRITICAL: the raw `[38;5;196m` pattern that used to leak when ESC
		// was stripped MUST be gone. If this fails the regression is back.
		const plain = stripAnsi(statusLine);
		expect(plain).not.toContain("[38;5;196m");
		expect(plain).not.toContain("[38;5;208m");
		expect(plain).not.toContain("[0m");

		// The actual visible glyphs and labels survive.
		expect(plain).toContain("⠠");
		expect(plain).toContain("⠄");
		expect(plain).toContain("caveman level: FULL");

		// And the ANSI escape sequences themselves are still in the raw
		// output (terminals will interpret them as colours).
		expect(statusLine).toContain("\x1b[38;5;196m");
		expect(statusLine).toContain("\x1b[38;5;208m");
	});

	test("still strips genuine control characters (newlines, NUL, BEL)", () => {
		const statuses = new Map([["bad", "before\n\rmiddle\x00\x07after"]]);
		const footer = new FooterComponent(makeSession(), makeFooterData(statuses));
		const plain = stripAnsi(extensionStatusLine(footer));

		// `\n` and `\r` collapse to a single space (joined with subsequent text).
		// `\x00` and `\x07` are stripped outright.
		expect(plain).toContain("before middle");
		expect(plain).toContain("after");
		expect(plain).not.toMatch(/[\u0000\u0007\u000a\u000d]/);
	});

	test("joins multiple statuses with a single space, sorted alphabetically by key", () => {
		const statuses = new Map([
			["zzz", "Z"],
			["aaa", "A"],
			["mmm", "M"],
		]);
		const footer = new FooterComponent(makeSession(), makeFooterData(statuses));
		const plain = stripAnsi(extensionStatusLine(footer));
		expect(plain.indexOf("A")).toBeLessThan(plain.indexOf("M"));
		expect(plain.indexOf("M")).toBeLessThan(plain.indexOf("Z"));
	});

	test("collapses runs of whitespace to a single space (preserves alignment)", () => {
		const statuses = new Map([["padded", "alpha     beta\t\t\tgamma"]]);
		const footer = new FooterComponent(makeSession(), makeFooterData(statuses));
		const plain = stripAnsi(extensionStatusLine(footer));
		expect(plain).toContain("alpha beta gamma");
		expect(plain).not.toMatch(/\s{2,}/);
	});
});

describe("FooterComponent no-rails alert", () => {
	test("renders a loud NO-RAILS alert line when the permission floor is off", () => {
		const statuses = new Map([["permissions", "permissions: no-rails"]]);
		const footer = new FooterComponent(makeSession(), makeFooterData(statuses));
		const lines = footer.render(200);

		const alertLine = lines.find((line) => stripAnsi(line).includes("NO-RAILS"));
		expect(alertLine).toBeDefined();
		// The alert text survives and names the dropped-floor state explicitly.
		expect(stripAnsi(alertLine!)).toContain("NO-RAILS — built-in guard-rails off");
		// It is the visual "shout": a hard-coded bold sequence wraps the line.
		expect(alertLine).toContain("\x1b[1m");
	});

	test("does not render the NO-RAILS alert in guarded auto mode", () => {
		const statuses = new Map([["permissions", "permissions: auto"]]);
		const footer = new FooterComponent(makeSession(), makeFooterData(statuses));
		const plain = footer.render(200).map(stripAnsi).join("\n");

		expect(plain).not.toContain("NO-RAILS");
		// auto is still surfaced (dim) on the metrics line.
		expect(plain).toContain("auto");
	});

	test("does not render the NO-RAILS alert in plan mode", () => {
		const statuses = new Map([["permissions", "permissions: plan"]]);
		const footer = new FooterComponent(makeSession(), makeFooterData(statuses));
		const plain = footer.render(200).map(stripAnsi).join("\n");

		expect(plain).not.toContain("NO-RAILS");
		expect(plain).toContain("plan");
	});
});
