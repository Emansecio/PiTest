// Test the tree builders by importing through the component module's behavior:
// we exercise SessionList via SessionSelectorComponent setSessions path.
import { setKeybindings } from "@pit/tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { SessionInfo } from "../src/core/session-manager.js";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function makeSession(overrides: Partial<SessionInfo> & { id: string; path: string }): SessionInfo {
	return {
		path: overrides.path,
		id: overrides.id,
		cwd: overrides.cwd ?? "/tmp",
		name: overrides.name,
		parentSessionPath: overrides.parentSessionPath,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(1),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? overrides.id,
		allMessagesText: overrides.allMessagesText ?? overrides.id,
	};
}

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("session selector threaded tree cycles", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("does not hang Loading when parentSessionPath forms a 2-cycle", async () => {
		const a = "/tmp/sessions/a.jsonl";
		const b = "/tmp/sessions/b.jsonl";
		const sessions = [
			makeSession({ id: "a", path: a, parentSessionPath: b, firstMessage: "session-a" }),
			makeSession({ id: "b", path: b, parentSessionPath: a, firstMessage: "session-b" }),
		];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => sessions,
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);

		const result = await Promise.race([
			(async () => {
				await new Promise<void>((r) => setImmediate(r));
				await new Promise<void>((r) => setImmediate(r));
				return stripAnsi(selector.render(100).join("\n"));
			})(),
			new Promise<string>((_, rej) => setTimeout(() => rej(new Error("hung on cyclic parentSessionPath")), 1000)),
		]);

		expect(result).not.toMatch(/Loading/);
		expect(result).toMatch(/session-[ab]/);
	});

	it("does not hang Loading when a session parents itself", async () => {
		const a = "/tmp/sessions/self.jsonl";
		const sessions = [makeSession({ id: "self", path: a, parentSessionPath: a, firstMessage: "session-self" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);

		const result = await Promise.race([
			(async () => {
				await new Promise<void>((r) => setImmediate(r));
				await new Promise<void>((r) => setImmediate(r));
				return stripAnsi(selector.render(100).join("\n"));
			})(),
			new Promise<string>((_, rej) => setTimeout(() => rej(new Error("hung on self-parent")), 1000)),
		]);

		expect(result).not.toMatch(/Loading/);
		expect(result).toContain("session-self");
	});
});
