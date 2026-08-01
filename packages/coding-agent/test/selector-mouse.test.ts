/**
 * Mouse support for the SelectableRow-based selectors (/model, /resume, /tree,
 * extension and oauth pickers). Shared contract under test:
 *
 * - a left press on an UNSELECTED row moves the selection there (claimed);
 * - a left press on the ALREADY-SELECTED row confirms it (Enter semantics);
 * - clicks on rows are CLAIMED — the walker finds a MouseTarget and onMouse
 *   returns true, so the TUI never treats them as unclaimed presses (which
 *   would auto-suspend mouse tracking, the doc item's original bug);
 * - non-row surfaces (headers, hints, scroll info) and non-left/non-press
 *   events are declined so native terminal selection stays available there.
 *
 * Click delivery mirrors TUI.descendToMouseTarget: descend the live Container
 * chain via hitTestChild to the deepest MouseTarget, then call onMouse — so
 * these tests also prove the rows are reachable through the real hit-test walk
 * (Container → … → SelectableRow / SessionList / TreeList).
 *
 * Style follows ask-picker.test.ts (leftPress factory) and the per-selector
 * harnesses in model-selector.test.ts / session-selector-navigation.test.ts /
 * tree-selector.test.ts.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Component, setKeybindings, type TUI } from "@pit/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { ResolvedPaths } from "../src/core/package-manager.js";
import type { SessionInfo, SessionMessageEntry, SessionTreeNode } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.js";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.js";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.js";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.js";
import { SelectableRow } from "../src/modes/interactive/components/selectable-row.js";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.js";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const SPACE = " ";
const CTRL_D = "\x04";
const WIDTH = 120;

const leftPress = (overrides: Record<string, unknown> = {}) =>
	({
		type: "press",
		button: "left",
		wheel: undefined,
		x: 1,
		y: 1,
		shift: false,
		ctrl: false,
		alt: false,
		raw: "",
		...overrides,
	}) as never;

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

async function flushPromises(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Deliver a mouse event to whatever renders `row` of `root`, mirroring
 * TUI.descendToMouseTarget: walk the live tree via hitTestChild to the deepest
 * onMouse component, translating the row on the way down. Returns false when
 * the walk dead-ends (no target under the row — an unclaimed press in the real
 * TUI) or when the target declines the event. `root` must have been rendered
 * since its last mutation, exactly like the real pipeline.
 */
function clickRow(root: Component, row: number, ev: unknown = leftPress()): boolean {
	let node = root as Component & {
		onMouse?: (ev: never, localRow: number, localCol: number) => boolean;
		hitTestChild?: (localRow: number) => { child: Component; childStart: number } | null;
	};
	let localRow = row;
	for (let depth = 0; depth < 64; depth++) {
		if (typeof node.onMouse === "function") {
			return node.onMouse(ev as never, localRow, 2);
		}
		if (typeof node.hitTestChild !== "function") return false;
		const hit = node.hitTestChild(localRow);
		if (!hit) return false;
		localRow -= hit.childStart;
		node = hit.child as typeof node;
	}
	return false;
}

/** Index of the first rendered line whose stripped text contains `needle` (−1 if absent). */
function rowOf(root: Component, needle: string): number {
	return root
		.render(WIDTH)
		.map(stripAnsi)
		.findIndex((line) => line.includes(needle));
}

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("SelectableRow mouse", () => {
	it("claims a left press only when a handler is wired", () => {
		let clicks = 0;
		const wired = new SelectableRow("→ item", true, 0, () => clicks++);
		expect(wired.onMouse(leftPress(), 0, 0)).toBe(true);
		expect(clicks).toBe(1);

		// No handler (legacy call sites): decline, native selection keeps working.
		const inert = new SelectableRow("→ item", true);
		expect(inert.onMouse(leftPress(), 0, 0)).toBe(false);
	});

	it("declines drags, releases and non-left presses", () => {
		let clicks = 0;
		const row = new SelectableRow("→ item", false, 0, () => clicks++);
		expect(row.onMouse(leftPress({ type: "drag" }), 0, 0)).toBe(false);
		expect(row.onMouse(leftPress({ type: "release" }), 0, 0)).toBe(false);
		expect(row.onMouse(leftPress({ button: "right" }), 0, 0)).toBe(false);
		expect(clicks).toBe(0);
	});
});

describe("ModelSelectorComponent mouse", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-selector-mouse-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function makeSelector(onSelect: (model: { id: string }) => void = () => {}): ModelSelectorComponent {
		const modelsJsonPath = join(tempDir, "models.json");
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					alpha: {
						baseUrl: "https://alpha.example.com/v1",
						apiKey: "k-alpha",
						api: "openai-completions",
						models: [
							{ id: "a1", name: "Alpha One" },
							{ id: "a2", name: "Alpha Two" },
							{ id: "a3", name: "Alpha Three" },
						],
					},
				},
			}),
		);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		registry.refresh();
		const current = registry.find("alpha", "a1")!;
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		return new ModelSelectorComponent(
			createFakeTui(),
			current,
			settingsManager,
			registry,
			[],
			onSelect as never,
			() => {},
		);
	}

	it("click on an unselected model row moves the selection (claimed, no confirm)", async () => {
		const picked: string[] = [];
		const selector = makeSelector((m) => picked.push(m.id));
		await flushPromises();

		selector.handleInput(SPACE); // expand the provider group
		const row = rowOf(selector, "Alpha Three");
		expect(row).toBeGreaterThan(-1);
		expect(clickRow(selector, row)).toBe(true);
		expect(selector.getSelectedModel()?.id).toBe("a3");
		expect(picked).toEqual([]);
	});

	it("click on the already-selected model row confirms it", async () => {
		const picked: string[] = [];
		const selector = makeSelector((m) => picked.push(m.id));
		await flushPromises();

		selector.handleInput(SPACE);
		const row = rowOf(selector, "Alpha Two");
		expect(clickRow(selector, row)).toBe(true); // first click: select
		expect(clickRow(selector, rowOf(selector, "Alpha Two"))).toBe(true); // second: confirm
		expect(picked).toEqual(["a2"]);
	});

	it("click on the selected group row toggles its expansion (Enter semantics)", async () => {
		const selector = makeSelector();
		await flushPromises();

		// Cursor opens parked on the (collapsed) provider group — its row carries
		// the model count "(3)".
		expect(selector.getSelectedModel()).toBeUndefined();
		const groupRow = rowOf(selector, "(3)");
		expect(groupRow).toBeGreaterThan(-1);
		expect(clickRow(selector, groupRow)).toBe(true);
		expect(stripAnsi(selector.render(WIDTH).join("\n"))).toContain("Alpha One"); // expanded
		expect(clickRow(selector, rowOf(selector, "(3)"))).toBe(true);
		expect(stripAnsi(selector.render(WIDTH).join("\n"))).not.toContain("Alpha One"); // collapsed
	});

	it("declines clicks on non-row chrome (header hint) — native selection there", async () => {
		const selector = makeSelector();
		await flushPromises();
		const hintRow = rowOf(selector, "Configured providers only");
		expect(hintRow).toBeGreaterThan(-1);
		expect(clickRow(selector, hintRow)).toBe(false);
	});
});

describe("SessionSelectorComponent mouse", () => {
	function makeSession(id: string, modified: Date): SessionInfo {
		return {
			path: `/tmp/${id}.jsonl`,
			id,
			cwd: "",
			name: id,
			parentSessionPath: undefined,
			created: new Date(0),
			modified,
			messageCount: 1,
			firstMessage: "hello",
			allMessagesText: "hello",
		};
	}

	function buildSelector(onSelect: (path: string) => void = () => {}): SessionSelectorComponent {
		const sessions = Array.from({ length: 5 }, (_, i) =>
			makeSession(`sess-${String(i).padStart(2, "0")}`, new Date((i + 1) * 1000)),
		);
		return new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			onSelect,
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);
	}

	it("click selects an unselected row; a second click on it resumes (confirm)", async () => {
		const picked: string[] = [];
		const selector = buildSelector((path) => picked.push(path));
		await flushPromises();
		const list = selector.getSessionList();

		const row = rowOf(selector, "sess-02");
		expect(row).toBeGreaterThan(-1);
		expect(list.getSelectedSessionPath()).not.toBe("/tmp/sess-02.jsonl");

		expect(clickRow(selector, row)).toBe(true); // select, no confirm
		expect(list.getSelectedSessionPath()).toBe("/tmp/sess-02.jsonl");
		expect(picked).toEqual([]);

		expect(clickRow(selector, rowOf(selector, "sess-02"))).toBe(true); // confirm
		expect(picked).toEqual(["/tmp/sess-02.jsonl"]);
	});

	it("declines clicks on the search box and blank rows (not unclaimed row presses)", async () => {
		const selector = buildSelector();
		await flushPromises();
		const searchRow = rowOf(selector, "Search sessions");
		expect(searchRow).toBeGreaterThan(-1);
		expect(clickRow(selector, searchRow)).toBe(false);
	});

	it("a click during delete-confirmation only dismisses the confirmation", async () => {
		const picked: string[] = [];
		const selector = buildSelector((path) => picked.push(path));
		await flushPromises();
		const list = selector.getSessionList();

		list.handleInput(CTRL_D); // arm delete confirmation on the selected row
		expect(stripAnsi(selector.render(WIDTH).join("\n"))).toContain("Delete session?");

		const selectedName = list.getSelectedSessionPath()!.match(/sess-\d+/)![0];
		expect(clickRow(selector, rowOf(selector, selectedName))).toBe(true);
		expect(stripAnsi(selector.render(WIDTH).join("\n"))).not.toContain("Delete session?");
		expect(picked).toEqual([]); // neither confirmed nor deleted
	});
});

describe("TreeSelectorComponent mouse", () => {
	function userMessage(id: string, parentId: string | null, content: string): SessionMessageEntry {
		return {
			type: "message",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			message: { role: "user", content, timestamp: Date.now() },
		} as SessionMessageEntry;
	}

	function buildTree(entries: SessionMessageEntry[]): SessionTreeNode[] {
		const nodes: SessionTreeNode[] = entries.map((entry) => ({ entry, children: [] }));
		const byId = new Map(nodes.map((n) => [n.entry.id, n]));
		const roots: SessionTreeNode[] = [];
		for (const node of nodes) {
			const parent = node.entry.parentId ? byId.get(node.entry.parentId) : undefined;
			if (parent) parent.children.push(node);
			else roots.push(node);
		}
		return roots;
	}

	function makeSelector(onSelect: (entryId: string) => void = () => {}): TreeSelectorComponent {
		const tree = buildTree([
			userMessage("u1", null, "first message"),
			userMessage("u2", "u1", "second message"),
			userMessage("u3", "u2", "third message"),
		]);
		return new TreeSelectorComponent(tree, "u3", 40, onSelect, () => {});
	}

	it("click selects an unselected entry; a second click on it confirms", () => {
		const picked: string[] = [];
		const selector = makeSelector((id) => picked.push(id));

		// Cursor opens on the current leaf (u3); click the first entry instead.
		expect(selector.getTreeList().getSelectedNode()?.entry.id).toBe("u3");
		const row = rowOf(selector, "first message");
		expect(row).toBeGreaterThan(-1);

		expect(clickRow(selector, row)).toBe(true); // select, no confirm
		expect(selector.getTreeList().getSelectedNode()?.entry.id).toBe("u1");
		expect(picked).toEqual([]);

		expect(clickRow(selector, rowOf(selector, "first message"))).toBe(true); // confirm
		expect(picked).toEqual(["u1"]);
	});

	it("declines clicks past the item rows (scroll/status line) and non-press events", () => {
		const picked: string[] = [];
		const selector = makeSelector((id) => picked.push(id));
		const list = selector.getTreeList();
		selector.render(WIDTH);

		// The trailing "(n/m)" status line is one past the last item row.
		expect(list.onMouse(leftPress(), 3, 0)).toBe(false);
		expect(list.onMouse(leftPress({ type: "release" }), 0, 0)).toBe(false);
		expect(list.onMouse(leftPress({ button: "right" }), 0, 0)).toBe(false);
		expect(picked).toEqual([]);
	});
});

describe("ExtensionSelectorComponent mouse", () => {
	it("click selects an unselected option; a second click on it confirms", () => {
		const picked: string[] = [];
		const selector = new ExtensionSelectorComponent(
			"Pick one",
			["one", "two", "three"],
			(option) => picked.push(option),
			() => {},
		);

		const row = rowOf(selector, "two");
		expect(row).toBeGreaterThan(-1);
		expect(clickRow(selector, row)).toBe(true); // select
		expect(picked).toEqual([]);
		expect(clickRow(selector, rowOf(selector, "two"))).toBe(true); // confirm
		expect(picked).toEqual(["two"]);
	});
});

describe("ConfigSelectorComponent mouse", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-config-mouse-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("click selects an unselected item; a second click toggles it; headers decline", () => {
		const skill = (name: string) => ({
			path: join(tempDir, "skills", name, "SKILL.md"),
			enabled: true,
			metadata: { source: "auto", scope: "user" as const, origin: "top-level" as const, baseDir: tempDir },
		});
		const resolved: ResolvedPaths = {
			extensions: [],
			skills: [skill("alpha"), skill("beta")],
			prompts: [],
			themes: [],
		};
		const selector = new ConfigSelectorComponent(
			resolved,
			SettingsManager.create(tempDir, tempDir),
			tempDir,
			tempDir,
			() => {},
			() => {},
			() => {},
		);
		const toggles: Array<{ name: string; enabled: boolean }> = [];
		selector.getResourceList().onToggle = (item, enabled) => toggles.push({ name: item.displayName, enabled });

		// Group headers are not selectable — clicks decline (native selection).
		expect(clickRow(selector, rowOf(selector, "User ("))).toBe(false);

		// Selection opens on the first item ("alpha"); click "beta" to move it.
		const row = rowOf(selector, "beta");
		expect(row).toBeGreaterThan(-1);
		expect(clickRow(selector, row)).toBe(true); // select, no toggle
		expect(toggles).toEqual([]);

		expect(clickRow(selector, rowOf(selector, "beta"))).toBe(true); // toggle
		expect(toggles).toEqual([{ name: "beta", enabled: false }]);
	});
});

describe("OAuthSelectorComponent mouse", () => {
	it("click selects an unselected provider; a second click on it confirms", () => {
		const picked: string[] = [];
		const selector = new OAuthSelectorComponent(
			"login",
			AuthStorage.inMemory(),
			[
				{ id: "anthropic", name: "Anthropic", authType: "oauth" },
				{ id: "xai", name: "xAI Grok", authType: "oauth" },
			],
			(providerId) => picked.push(providerId),
			() => {},
		);

		const row = rowOf(selector, "xAI Grok");
		expect(row).toBeGreaterThan(-1);
		expect(clickRow(selector, row)).toBe(true); // select
		expect(picked).toEqual([]);
		expect(clickRow(selector, rowOf(selector, "xAI Grok"))).toBe(true); // confirm
		expect(picked).toEqual(["xai"]);
	});
});
