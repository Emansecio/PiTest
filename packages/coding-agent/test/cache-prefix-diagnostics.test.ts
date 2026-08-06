import { Agent } from "@pit/agent-core";
import { getModel, onDiagnostic, type RecordedDiagnosticEvent, splitSystemPromptOnDynamic } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { PermissionChecker } from "../src/core/permissions/checker.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-5")!;

function createSession(permissionChecker?: PermissionChecker): AgentSession {
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	return new AgentSession({
		permissionChecker,
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});
}

describe("AgentSession.getCachePrefixDiagnostics", () => {
	it("returns a well-formed diagnostic", async () => {
		const session = createSession();
		try {
			const diag = session.getCachePrefixDiagnostics();
			expect(typeof diag.rebuilds).toBe("number");
			expect(diag.rebuilds).toBeGreaterThanOrEqual(0);
			expect(Array.isArray(diag.reasons)).toBe(true);
		} finally {
			await session.dispose();
		}
	});

	it("does not count a rebuild that leaves the cacheable prefix unchanged", async () => {
		const session = createSession();
		try {
			const names = session.getActiveToolNames();
			session.setActiveToolsByName([...names]);
			const a = session.getCachePrefixDiagnostics().rebuilds;
			session.setActiveToolsByName([...names]);
			const b = session.getCachePrefixDiagnostics().rebuilds;
			// Identical tool set → identical prefix → the rebuild is not a rewrite.
			expect(b).toBe(a);
		} finally {
			await session.dispose();
		}
	});

	it("counts a tool-surface change that rewrites the prefix, attributed by reason", async () => {
		const session = createSession();
		try {
			// Establish a known, rich surface, then strip it down. With fewer tools
			// the textual tool list and tool-derived guidelines (e.g. the
			// verify-after-change nudge, which needs edit/write + bash) shrink, so
			// the cacheable prefix genuinely changes and is counted once.
			session.setActiveToolsByName(["read", "bash", "edit", "write"]);
			const before = session.getCachePrefixDiagnostics().rebuilds;

			session.setActiveToolsByName(["read"]);
			const after = session.getCachePrefixDiagnostics();

			expect(after.rebuilds).toBeGreaterThan(before);
			expect(after.reasons.map((r) => r.reason)).toContain("tool-surface");
		} finally {
			await session.dispose();
		}
	});
});

/**
 * Capture only the prefix-rewrite diagnostics recorded while `fn` runs. The
 * channel is a process-global, so a scoped subscription (rather than a reset) is
 * what keeps this test honest next to the rest of the suite.
 */
function capturePrefixRewrites(fn: () => void): RecordedDiagnosticEvent[] {
	const seen: RecordedDiagnosticEvent[] = [];
	const unsubscribe = onDiagnostic((event) => {
		if (event.category === "quality.cache-prefix-rewrite") seen.push(event);
	});
	try {
		fn();
	} finally {
		unsubscribe();
	}
	return seen;
}

/**
 * The invariant this whole mechanism rests on: rewriting the cacheable prefix
 * re-bills it as a cache write, so the counter must move on CONTENT change and on
 * nothing else — not on the number of rebuild calls, and not on churn confined to
 * the dynamic suffix.
 */
describe("AgentSession — prefix rewrites are counted by content, not by call", () => {
	const rebuild = (session: AgentSession, reason: string): void => {
		(session as any)._baseSystemPrompt = (session as any)._rebuildSystemPrompt(session.getActiveToolNames(), reason);
	};

	it("counts nothing when N rebuilds produce the same prefix", async () => {
		const session = createSession();
		try {
			rebuild(session, "tool-surface");
			const before = session.getCachePrefixDiagnostics().rebuilds;

			const events = capturePrefixRewrites(() => {
				for (let i = 0; i < 5; i++) rebuild(session, "tool-surface");
			});

			expect(session.getCachePrefixDiagnostics().rebuilds).toBe(before);
			expect(events).toHaveLength(0);
		} finally {
			await session.dispose();
		}
	});

	it("counts nothing when only the dynamic suffix moves", async () => {
		const session = createSession();
		try {
			rebuild(session, "context-composer-turn");
			const before = session.getCachePrefixDiagnostics().rebuilds;
			const prefixBefore = splitSystemPromptOnDynamic((session as any)._baseSystemPrompt as string).staticPart;

			// The session frequent-files tracker is rendered AFTER the dynamic marker
			// precisely so that its churn is free. Record past `minHits` (default 2) so
			// the block genuinely appears, then rebuild.
			const tracker = (session as any)._frequentFiles;
			for (let i = 0; i < 3; i++) tracker.record("src/core/agent-session.ts", "read");

			const events = capturePrefixRewrites(() => rebuild(session, "context-composer-turn"));

			const after = splitSystemPromptOnDynamic((session as any)._baseSystemPrompt as string);
			expect(after.dynamicPart).toContain("agent-session.ts");
			expect(after.staticPart).toBe(prefixBefore);
			expect(session.getCachePrefixDiagnostics().rebuilds).toBe(before);
			expect(events).toHaveLength(0);
		} finally {
			await session.dispose();
		}
	});

	it("counts exactly one rewrite for a permission-mode switch, recorded as deliberate", async () => {
		const checker = new PermissionChecker({ cwd: process.cwd(), mode: "auto", settings: {} });
		const session = createSession(checker);
		try {
			const before = session.getCachePrefixDiagnostics().rebuilds;
			checker.updateMode("plan");

			const events = capturePrefixRewrites(() => (session as any)._syncPromptSessionState());

			expect(session.getCachePrefixDiagnostics().rebuilds).toBe(before + 1);
			expect(events).toHaveLength(1);
			const event = events[0]!;
			expect(event.context?.reason).toBe("permission-mode");
			expect(event.context?.rebuildCount).toBe(before + 1);
			// Deliberate transitions are still recorded — visibility, not alarm.
			expect(event.context?.deliberate).toBe(true);
			expect(event.level).toBe("info");
		} finally {
			await session.dispose();
		}
	});

	it("records an unplanned rewrite as a warning carrying its cost estimate", async () => {
		const session = createSession();
		try {
			session.setActiveToolsByName(["read", "bash", "edit", "write"]);

			const events = capturePrefixRewrites(() => session.setActiveToolsByName(["read"]));

			expect(events).toHaveLength(1);
			const event = events[0]!;
			expect(event.level).toBe("warn");
			expect(event.context?.reason).toBe("tool-surface");
			expect(event.context?.deliberate).toBeUndefined();
			// Prefix size is always reported; the wire estimate is present whenever the
			// model exposes a context window (it does here).
			expect(event.context?.bytes).toBeGreaterThan(0);
			expect(event.context?.historyTokens).toBeGreaterThan(0);
		} finally {
			await session.dispose();
		}
	});
});

/**
 * The permission-mode stance and the goal persistence rules live in the CACHEABLE
 * PREFIX: fixed text whose presence flips only on a deliberate, rare event. The
 * trade only holds if the prompt is actually rebuilt on those events (and on
 * nothing else), which is what `_syncPromptSessionState` does at turn start.
 */
describe("AgentSession — cacheable-prefix session state", () => {
	const sync = (session: AgentSession) => (session as any)._syncPromptSessionState();
	const prompt = (session: AgentSession) => (session as any)._baseSystemPrompt as string;
	const prefix = (session: AgentSession) => splitSystemPromptOnDynamic(prompt(session)).staticPart;

	it("puts the mode stance in the prefix and rebuilds once per mode switch", async () => {
		const checker = new PermissionChecker({ cwd: process.cwd(), mode: "auto", settings: {} });
		const session = createSession(checker);
		try {
			expect(prompt(session)).not.toContain("<plan_mode>");
			const before = session.getCachePrefixDiagnostics().rebuilds;

			checker.updateMode("plan");
			sync(session);
			expect(prefix(session)).toContain("<plan_mode>");
			expect(splitSystemPromptOnDynamic(prompt(session)).dynamicPart).not.toContain("<plan_mode>");
			const afterSwitch = session.getCachePrefixDiagnostics();
			expect(afterSwitch.rebuilds).toBe(before + 1);
			expect(afterSwitch.reasons.map((r) => r.reason)).toContain("permission-mode");

			// Turns that do not change the mode must not touch the prefix.
			const stable = prefix(session);
			sync(session);
			sync(session);
			expect(prefix(session)).toBe(stable);
			expect(session.getCachePrefixDiagnostics().rebuilds).toBe(afterSwitch.rebuilds);

			checker.updateMode("ask");
			sync(session);
			expect(prefix(session)).toContain("<ask_mode>");
			expect(prefix(session)).not.toContain("<plan_mode>");
		} finally {
			await session.dispose();
		}
	});

	it("puts the goal rules in the prefix and the objective in the suffix", async () => {
		const session = createSession();
		try {
			expect(prompt(session)).not.toContain("<goal_rules>");
			const before = session.getCachePrefixDiagnostics().rebuilds;

			session.startGoal("Ship the feature");
			sync(session);
			expect(prefix(session)).toContain("<goal_rules>");
			// The objective itself is per-turn state and never enters the prefix — it
			// is appended after the marker when the turn is assembled.
			expect(prefix(session)).not.toContain("Ship the feature");
			const started = session.getCachePrefixDiagnostics();
			// > before, not exactly +1: starting a goal also adds `goal_complete` to
			// the tool surface, which rewrites the prefix on its own. Both rewrites
			// land before the next request, so they cost ONE cache miss between them.
			expect(started.rebuilds).toBeGreaterThan(before);
			expect(started.reasons.map((r) => r.reason)).toContain("goal-lifecycle");

			// Pause/resume is frequent and must be free: the prefix stays byte-identical.
			const withGoal = prefix(session);
			session.pauseGoal();
			sync(session);
			expect(prefix(session)).toBe(withGoal);
			session.resumeGoal();
			sync(session);
			expect(prefix(session)).toBe(withGoal);
			expect(session.getCachePrefixDiagnostics().rebuilds).toBe(started.rebuilds);

			// Clearing the last goal drops the block.
			session.clearGoal();
			sync(session);
			expect(prefix(session)).not.toContain("<goal_rules>");
		} finally {
			await session.dispose();
		}
	});
});
