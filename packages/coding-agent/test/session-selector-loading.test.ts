import { setKeybindings } from "@pit/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { SessionInfo } from "../src/core/session-manager.js";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "/tmp",
		name: overrides.name,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(1),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? `message-${overrides.id}`,
		allMessagesText: overrides.allMessagesText ?? `message-${overrides.id}`,
	};
}

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (err: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	let reject: (err: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("session selector loading lifecycle", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("clears Loading after current-folder sessions resolve", async () => {
		const deferred = createDeferred<SessionInfo[]>();
		const sessions = [makeSession({ id: "a", firstMessage: "hello-from-session" })];

		const selector = new SessionSelectorComponent(
			() => deferred.promise,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);

		const pending = stripAnsi(selector.render(120).join("\n"));
		expect(pending).toMatch(/Loading/);
		// While the load is in flight the body mirrors the header's loading
		// state instead of contradicting it with empty-state advice.
		expect(pending).toContain("Loading sessions…");
		expect(pending).not.toContain("No sessions in current folder");

		deferred.resolve(sessions);
		await deferred.promise;
		await new Promise<void>((r) => setImmediate(r));
		await new Promise<void>((r) => setImmediate(r));

		const done = stripAnsi(selector.render(120).join("\n"));
		expect(done).not.toMatch(/Loading/);
		expect(done).toContain("hello-from-session");
		expect(done).toContain("Current Folder");
	});

	it("clears Loading when the loader returns an empty list", async () => {
		const deferred = createDeferred<SessionInfo[]>();
		const selector = new SessionSelectorComponent(
			() => deferred.promise,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);

		expect(stripAnsi(selector.render(100).join("\n"))).toMatch(/Loading/);

		deferred.resolve([]);
		await deferred.promise;
		await new Promise<void>((r) => setImmediate(r));
		await new Promise<void>((r) => setImmediate(r));

		const done = stripAnsi(selector.render(100).join("\n"));
		expect(done).not.toMatch(/Loading/);
		expect(done).toContain("No sessions in current folder");
	});

	it("clears Loading and surfaces an error when the loader rejects", async () => {
		const deferred = createDeferred<SessionInfo[]>();
		const selector = new SessionSelectorComponent(
			() => deferred.promise,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);

		deferred.reject(new Error("disk unavailable"));
		await deferred.promise.catch(() => {});
		await new Promise<void>((r) => setImmediate(r));
		await new Promise<void>((r) => setImmediate(r));

		const done = stripAnsi(selector.render(100).join("\n"));
		expect(done).not.toMatch(/Loading/);
		expect(done).toContain("Failed to load sessions");
	});

	it("clears Loading after the session-list timeout when the loader never settles", async () => {
		vi.useFakeTimers();
		const selector = new SessionSelectorComponent(
			() => new Promise<SessionInfo[]>(() => {}),
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);

		expect(stripAnsi(selector.render(100).join("\n"))).toMatch(/Loading/);

		await vi.advanceTimersByTimeAsync(20_000);
		await Promise.resolve();
		await Promise.resolve();

		const done = stripAnsi(selector.render(100).join("\n"));
		expect(done).not.toMatch(/Loading/);
		expect(done).toContain("Failed to load sessions");
		expect(done).toContain("timed out");
	});
});
