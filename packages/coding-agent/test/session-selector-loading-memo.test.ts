/**
 * Repro: SelectorCard/Box memoization must not keep a stale "Loading" frame
 * after SessionSelectorComponent finishes loading.
 */
import { setKeybindings } from "@pit/tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { SessionInfo } from "../src/core/session-manager.js";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function makeSession(id: string): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/tmp",
		created: new Date(0),
		modified: new Date(1),
		messageCount: 1,
		firstMessage: `session-${id}`,
		allMessagesText: `session-${id}`,
	};
}

describe("session selector + SelectorCard memo", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("does not keep a stale Loading frame after async load (card memo)", async () => {
		let resolve!: (v: SessionInfo[]) => void;
		const pending = new Promise<SessionInfo[]>((r) => {
			resolve = r;
		});

		const selector = new SessionSelectorComponent(
			() => pending,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);

		// Simulate TUI frames while loading
		const frame1 = stripAnsi(selector.render(100).join("\n"));
		expect(frame1).toMatch(/Loading/);
		const frame2 = stripAnsi(selector.render(100).join("\n"));
		expect(frame2).toMatch(/Loading/);

		resolve([makeSession("x")]);
		await pending;
		await new Promise<void>((r) => setImmediate(r));
		await new Promise<void>((r) => setImmediate(r));

		// Multiple frames after load — memo must not resurrect Loading
		for (let i = 0; i < 5; i++) {
			const frame = stripAnsi(selector.render(100).join("\n"));
			expect(frame, `frame ${i}`).not.toMatch(/Loading/);
			expect(frame, `frame ${i}`).toContain("session-x");
		}
	});

	it("survives scope toggle while current load is still in flight", async () => {
		let resolveCurrent!: (v: SessionInfo[]) => void;
		let resolveAll!: (v: SessionInfo[]) => void;
		const currentPending = new Promise<SessionInfo[]>((r) => {
			resolveCurrent = r;
		});
		const allPending = new Promise<SessionInfo[]>((r) => {
			resolveAll = r;
		});

		const selector = new SessionSelectorComponent(
			() => currentPending,
			() => allPending,
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);

		expect(stripAnsi(selector.render(100).join("\n"))).toMatch(/Loading/);

		// Tab → All while current still loading
		selector.getSessionList().handleInput("\t");
		await new Promise<void>((r) => setImmediate(r));

		const mid = stripAnsi(selector.render(100).join("\n"));
		expect(mid).toMatch(/Resume Session \(All\)/);
		expect(mid).toMatch(/Loading/);

		resolveAll([makeSession("all-1")]);
		await allPending;
		await new Promise<void>((r) => setImmediate(r));
		await new Promise<void>((r) => setImmediate(r));

		const allDone = stripAnsi(selector.render(100).join("\n"));
		expect(allDone).not.toMatch(/Loading/);
		expect(allDone).toContain("session-all-1");

		// Late current resolve must not clobber All view or re-stick Loading
		resolveCurrent([makeSession("cur-1")]);
		await currentPending;
		await new Promise<void>((r) => setImmediate(r));
		await new Promise<void>((r) => setImmediate(r));

		const stillAll = stripAnsi(selector.render(100).join("\n"));
		expect(stillAll).not.toMatch(/Loading/);
		expect(stillAll).toContain("session-all-1");
		expect(stillAll).toMatch(/Resume Session \(All\)/);

		// Tab back to current — should show resolved current sessions, not Loading
		selector.getSessionList().handleInput("\t");
		const back = stripAnsi(selector.render(100).join("\n"));
		expect(back).not.toMatch(/Loading/);
		expect(back).toContain("session-cur-1");
		expect(back).toMatch(/Resume Session \(Current Folder\)/);
	});
});
