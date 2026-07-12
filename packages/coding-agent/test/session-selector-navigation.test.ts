/**
 * Behavior-standardization tests for the session selector: page/home/end list
 * navigation (clamped, no wrap), the two-step Esc in the browsing state, Esc
 * still exiting rename / delete-confirmation modes first, and the adaptive
 * visible-row window (with a hardcoded fallback when no TUI is provided).
 */

import { setKeybindings, type TUI } from "@pit/tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { SessionInfo } from "../src/core/session-manager.js";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const ESC = "\x1b";
const HOME = "\x1b[H";
const END = "\x1b[F";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const UP = "\x1b[A";
const CTRL_D = "\x04";
const CTRL_R = "\x1b[114;5u"; // Kitty encoding for Ctrl+R

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		parentSessionPath: overrides.parentSessionPath,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
	};
}

function makeNumberedSessions(count: number): SessionInfo[] {
	return Array.from({ length: count }, (_, i) => {
		const id = `sess-${String(i).padStart(2, "0")}`;
		return makeSession({ id, name: id, modified: new Date((i + 1) * 1000) });
	});
}

function buildSelector(
	sessions: SessionInfo[],
	opts: {
		keybindings: KeybindingsManager;
		onCancel?: () => void;
		renameSession?: (path: string, name: string | undefined) => Promise<void>;
		tui?: TUI;
	},
): SessionSelectorComponent {
	return new SessionSelectorComponent(
		async () => sessions,
		async () => [],
		() => {},
		opts.onCancel ?? (() => {}),
		() => {},
		() => {},
		{
			keybindings: opts.keybindings,
			showRenameHint: opts.renameSession ? true : false,
			renameSession: opts.renameSession,
		},
		undefined,
		opts.tui,
	);
}

describe("session selector navigation & Esc semantics", () => {
	const keybindings = new KeybindingsManager();

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// Navigation keybindings are read from the global singleton.
		setKeybindings(new KeybindingsManager());
	});

	it("home/end/page jump to first/last item, clamped (no wrap)", async () => {
		const sessions = makeNumberedSessions(20);
		const selector = buildSelector(sessions, { keybindings });
		await flushPromises();
		const list = selector.getSessionList();

		const first = list.getSelectedSessionPath();
		expect(first).toBeDefined();

		// End → last item; a second End stays put (no wrap to the top).
		list.handleInput(END);
		const last = list.getSelectedSessionPath();
		expect(last).not.toBe(first);
		list.handleInput(END);
		expect(list.getSelectedSessionPath()).toBe(last);

		// Home → first item; a second Home stays put (no wrap to the bottom).
		list.handleInput(HOME);
		expect(list.getSelectedSessionPath()).toBe(first);
		list.handleInput(HOME);
		expect(list.getSelectedSessionPath()).toBe(first);

		// Up and Page-up at the top stay clamped at the first item.
		list.handleInput(UP);
		expect(list.getSelectedSessionPath()).toBe(first);
		list.handleInput(PAGE_UP);
		expect(list.getSelectedSessionPath()).toBe(first);

		// Page-down from the top moves by the visible window (10 fallback) to a
		// middle item — distinct from both ends.
		list.handleInput(PAGE_DOWN);
		const mid = list.getSelectedSessionPath();
		expect(mid).not.toBe(first);
		expect(mid).not.toBe(last);
	});

	it("uses a two-step Esc when a search is active: first clears, second closes", async () => {
		const sessions = [makeSession({ id: "alpha", name: "alpha" }), makeSession({ id: "bravo", name: "bravo" })];
		let cancelled = 0;
		const selector = buildSelector(sessions, { keybindings, onCancel: () => cancelled++ });
		await flushPromises();
		const list = selector.getSessionList();

		for (const ch of "alph") list.handleInput(ch);

		// First Esc clears the filter (restores all sessions) without closing.
		list.handleInput(ESC);
		expect(cancelled).toBe(0);
		const afterClear = stripAnsi(selector.render(120).join("\n"));
		expect(afterClear).toContain("alpha");
		expect(afterClear).toContain("bravo");

		// Second Esc (empty search) closes.
		list.handleInput(ESC);
		expect(cancelled).toBe(1);
	});

	it("closes immediately on Esc when the search is already empty", async () => {
		const sessions = [makeSession({ id: "a" })];
		let cancelled = 0;
		const selector = buildSelector(sessions, { keybindings, onCancel: () => cancelled++ });
		await flushPromises();

		selector.getSessionList().handleInput(ESC);
		expect(cancelled).toBe(1);
	});

	it("Esc cancels a delete confirmation before it would close the selector", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];
		let cancelled = 0;
		const selector = buildSelector(sessions, { keybindings, onCancel: () => cancelled++ });
		await flushPromises();
		const list = selector.getSessionList();
		const changes: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => changes.push(path);

		list.handleInput(CTRL_D);
		expect(changes).toEqual([sessions[0]!.path]);

		// Esc exits confirmation mode; it must NOT close the selector.
		list.handleInput(ESC);
		expect(changes).toEqual([sessions[0]!.path, null]);
		expect(cancelled).toBe(0);
	});

	it("Esc exits rename mode before it would close the selector", async () => {
		const sessions = [makeSession({ id: "a", name: "Old" })];
		let cancelled = 0;
		const renameSession = vi.fn(async () => {});
		const selector = buildSelector(sessions, { keybindings, onCancel: () => cancelled++, renameSession });
		await flushPromises();

		selector.getSessionList().handleInput(CTRL_R);
		await flushPromises();
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Rename Session");

		// Esc leaves rename mode back to the list; the selector stays open.
		selector.handleInput(ESC);
		const out = stripAnsi(selector.render(120).join("\n"));
		expect(out).toContain("Resume Session");
		expect(out).not.toContain("Rename Session");
		expect(cancelled).toBe(0);
	});
});

describe("session selector adaptive height", () => {
	const keybindings = new KeybindingsManager();

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	const countRows = (selector: SessionSelectorComponent): number =>
		(stripAnsi(selector.render(120).join("\n")).match(/sess-\d\d/g) ?? []).length;

	it("falls back to a 10-row window when no TUI is provided", async () => {
		const selector = buildSelector(makeNumberedSessions(20), { keybindings });
		await flushPromises();
		expect(countRows(selector)).toBe(10);
	});

	it("adapts the window to terminal height when a TUI is provided", async () => {
		// clamp(rows - 12, 5, 15): rows 30 → 15.
		const fakeTui = { terminal: { rows: 30 }, requestRender: () => {} } as unknown as TUI;
		const selector = buildSelector(makeNumberedSessions(20), { keybindings, tui: fakeTui });
		await flushPromises();
		expect(countRows(selector)).toBe(15);
	});

	it("clamps the adaptive window to a 5-row minimum on short terminals", async () => {
		// clamp(rows - 12, 5, 15): rows 14 → 5.
		const fakeTui = { terminal: { rows: 14 }, requestRender: () => {} } as unknown as TUI;
		const selector = buildSelector(makeNumberedSessions(20), { keybindings, tui: fakeTui });
		await flushPromises();
		expect(countRows(selector)).toBe(5);
	});
});
