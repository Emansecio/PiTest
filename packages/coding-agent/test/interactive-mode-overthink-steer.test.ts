import { buildOverthinkReminderMessage } from "@pit/agent-core";
import { describe, expect, test, vi } from "vitest";
import { OverthinkSteerMessageComponent } from "../src/modes/interactive/components/overthink-steer-message.js";
import { TtsrSteerMessageComponent } from "../src/modes/interactive/components/ttsr-steer-message.js";
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

	test("addMessageToChat still renders normal user messages", () => {
		const added: unknown[] = [];
		const fakeThis = {
			clearEphemeralStatus: vi.fn(),
			chatContainer: { addChild: vi.fn((child: unknown) => added.push(child)) },
			toolOutputExpanded: false,
			getMarkdownThemeWithSettings: vi.fn(() => ({})),
			editor: { addToHistory: vi.fn() },
			getUserMessageText,
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
});
