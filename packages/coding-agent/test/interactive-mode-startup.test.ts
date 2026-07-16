import { Container, Text, type TUI } from "@pit/tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

describe("interactive startup lifecycle", () => {
	test("hides chat while active and fully tears down on dismissal", () => {
		const unsubscribe = vi.fn();
		const chat = new Text("history", 0, 0);
		const startupContainer = new Container();
		const chatVisibilityContainer = new Container();
		chatVisibilityContainer.addChild(chat);
		const fakeThis = {
			welcomeActive: false,
			startupScreen: undefined,
			startupAnimationUnsub: unsubscribe,
			startupContainer,
			chatVisibilityContainer,
			chatContainer: chat,
			ui: {
				terminal: { rows: 40 },
				requestRender: vi.fn(),
			} as unknown as TUI,
			updateEmptyStateHint: vi.fn(),
			stopStartupAnimation: Reflect.get(InteractiveMode.prototype, "stopStartupAnimation"),
		};
		const activate = Reflect.get(InteractiveMode.prototype, "activateStartupScreen") as (
			this: typeof fakeThis,
		) => void;
		const dismiss = Reflect.get(InteractiveMode.prototype, "dismissStartupScreen") as (this: typeof fakeThis) => void;

		activate.call(fakeThis);
		expect(fakeThis.welcomeActive).toBe(true);
		expect(chatVisibilityContainer.children).toHaveLength(0);
		expect(startupContainer.children).toHaveLength(2);

		dismiss.call(fakeThis);
		expect(fakeThis.welcomeActive).toBe(false);
		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(startupContainer.children).toHaveLength(0);
		expect(chatVisibilityContainer.children).toEqual([chat]);
	});

	test("activates on initial/resumed sessions and session swaps, but skips CLI prompts", async () => {
		const rebind = Reflect.get(InteractiveMode.prototype, "rebindCurrentSession") as (
			this: Record<string, unknown>,
		) => Promise<void>;
		const managerA = {};
		const activateStartupScreen = vi.fn();
		const fakeThis: Record<string, unknown> = {
			startupSessionManager: undefined,
			sessionManager: managerA,
			options: {},
			unsubscribe: undefined,
			applyRuntimeSettings: vi.fn(),
			bindCurrentSessionExtensions: vi.fn(),
			subscribeToAgent: vi.fn(),
			updateAvailableProviderCount: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			restorePersistedFollowUpDrafts: vi.fn(),
			updateTerminalTitle: vi.fn(),
			activateStartupScreen,
		};

		await rebind.call(fakeThis);
		expect(activateStartupScreen).toHaveBeenCalledOnce();

		activateStartupScreen.mockClear();
		await rebind.call(fakeThis);
		expect(activateStartupScreen).not.toHaveBeenCalled();

		fakeThis.sessionManager = {};
		await rebind.call(fakeThis);
		expect(activateStartupScreen).toHaveBeenCalledOnce();

		activateStartupScreen.mockClear();
		fakeThis.startupSessionManager = undefined;
		fakeThis.sessionManager = {};
		fakeThis.options = { initialMessage: "run now" };
		await rebind.call(fakeThis);
		expect(activateStartupScreen).not.toHaveBeenCalled();
	});
});
