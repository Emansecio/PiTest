import { buildOverthinkReminderMessage } from "@pit/agent-core";
import { describe, expect, test, vi } from "vitest";
import { OverthinkSteerMessageComponent } from "../src/modes/interactive/components/overthink-steer-message.js";
import { TtsrSteerMessageComponent } from "../src/modes/interactive/components/ttsr-steer-message.js";
import { TurnRule } from "../src/modes/interactive/components/turn-rule.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

describe("InteractiveMode overthink steer rendering", () => {
	const getUserMessageText = Reflect.get(InteractiveMode.prototype, "getUserMessageText") as (message: {
		role: string;
		content: unknown;
	}) => string;
	const disposeActiveStreamingComponent = Reflect.get(
		InteractiveMode.prototype,
		"disposeActiveStreamingComponent",
	) as (this: {
		streamingComponent?: unknown;
		streamingAttached?: boolean;
		chatContainer?: { removeChild: (c: unknown) => void };
	}) => void;

	test("addMessageToChat renders a compact overthink line instead of UserMessageComponent", () => {
		const added: unknown[] = [];
		const fakeThis = {
			clearEphemeralStatus: vi.fn(),
			chatContainer: { addChild: vi.fn((child: unknown) => added.push(child)), removeChild: vi.fn() },
			toolOutputExpanded: false,
			getMarkdownThemeWithSettings: vi.fn(),
			editor: { addToHistory: vi.fn() },
			getUserMessageText,
			disposeActiveStreamingComponent,
		};

		const addMessageToChat = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (
			this: typeof fakeThis,
			message: ReturnType<typeof buildOverthinkReminderMessage>,
			options?: { populateHistory?: boolean },
		) => void;

		const overthinkMessage = buildOverthinkReminderMessage({ estimatedTokens: 1203, threshold: 1000 });
		addMessageToChat.call(fakeThis, overthinkMessage);

		expect(added).toHaveLength(1);
		expect(added[0]).toBeInstanceOf(OverthinkSteerMessageComponent);
		expect(fakeThis.editor.addToHistory).not.toHaveBeenCalled();
	});

	test("addMessageToChat renders a compact TTSR line instead of UserMessageComponent", () => {
		const added: unknown[] = [];
		const fakeThis = {
			clearEphemeralStatus: vi.fn(),
			chatContainer: { addChild: vi.fn((child: unknown) => added.push(child)), removeChild: vi.fn() },
			toolOutputExpanded: false,
			getMarkdownThemeWithSettings: vi.fn(),
			editor: { addToHistory: vi.fn() },
			getUserMessageText,
			disposeActiveStreamingComponent,
		};

		const addMessageToChat = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (
			this: typeof fakeThis,
			message: {
				role: "user";
				content: Array<{ type: "text"; text: string }>;
				timestamp: number;
			},
		) => void;

		addMessageToChat.call(fakeThis, {
			role: "user",
			content: [
				{
					type: "text",
					text: "<system-reminder>[TTSR:no-apology] Do not apologize.</system-reminder>",
				},
			],
			timestamp: Date.now(),
		});

		expect(added).toHaveLength(1);
		expect(added[0]).toBeInstanceOf(TtsrSteerMessageComponent);
		expect(fakeThis.editor.addToHistory).not.toHaveBeenCalled();
	});

	const maybeAddTurnRule = Reflect.get(InteractiveMode.prototype, "maybeAddTurnRule") as (this: {
		chatContainer: { children: unknown[]; addChild: (c: unknown) => void };
	}) => void;

	test("addMessageToChat still renders normal user messages", () => {
		const added: unknown[] = [];
		const fakeThis = {
			clearEphemeralStatus: vi.fn(),
			// `children` doubles as the rendered list so maybeAddTurnRule can gate on
			// prior content (empty here → no leading turn rule before the first prompt).
			chatContainer: { children: added, addChild: vi.fn((child: unknown) => added.push(child)) },
			maybeAddTurnRule,
			toolOutputExpanded: false,
			getMarkdownThemeWithSettings: vi.fn(() => ({})),
			editor: { addToHistory: vi.fn() },
			getUserMessageText,
			// UserMessageComponent caps its prose to the shared reading column.
			settingsManager: { getAssistantReadingColumns: vi.fn(() => 0) },
		};

		const addMessageToChat = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (
			this: typeof fakeThis,
			message: {
				role: "user";
				content: Array<{ type: "text"; text: string }>;
				timestamp: number;
			},
			options?: { populateHistory?: boolean },
		) => void;

		addMessageToChat.call(
			fakeThis,
			{
				role: "user",
				content: [{ type: "text", text: "fix the bug in footer.ts" }],
				timestamp: Date.now(),
			},
			{ populateHistory: true },
		);

		expect(added).toHaveLength(1);
		expect(added[0]).toBeInstanceOf(UserMessageComponent);
		expect(fakeThis.editor.addToHistory).toHaveBeenCalledWith("fix the bug in footer.ts");
	});

	test("addMessageToChat inserts a turn rule before a user prompt when prior content exists", () => {
		const priorBlock = { render: () => [] };
		const added: unknown[] = [priorBlock];
		const fakeThis = {
			clearEphemeralStatus: vi.fn(),
			chatContainer: { children: added, addChild: vi.fn((child: unknown) => added.push(child)) },
			maybeAddTurnRule,
			toolOutputExpanded: false,
			getMarkdownThemeWithSettings: vi.fn(() => ({})),
			editor: { addToHistory: vi.fn() },
			getUserMessageText,
			// maybeAddTurnRule sizes the hairline from the reading-width setting.
			settingsManager: { getAssistantReadingColumns: vi.fn(() => 0) },
		};

		const addMessageToChat = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (
			this: typeof fakeThis,
			message: { role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number },
		) => void;

		addMessageToChat.call(fakeThis, {
			role: "user",
			content: [{ type: "text", text: "and now add a test" }],
			timestamp: Date.now(),
		});

		// [priorBlock, TurnRule, UserMessageComponent]
		expect(added).toHaveLength(3);
		expect(added[1]).toBeInstanceOf(TurnRule);
		expect(added[2]).toBeInstanceOf(UserMessageComponent);
	});
});
