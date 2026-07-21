import { type Component, Container, getKeybindings, Spacer, Text, truncateToWidth } from "@pit/tui";
import { theme } from "../theme/theme.ts";
import { selectionCursor, themedScrollPositionHint } from "./keybinding-hints.ts";
import { beginSelectorSurface } from "./selector-surface.ts";

interface UserMessageItem {
	id: string; // Entry ID in the session
	text: string; // The message text
	timestamp?: string; // Optional timestamp if available
}

/**
 * Custom user message list component with selection
 */
class UserMessageList implements Component {
	private messages: UserMessageItem[] = [];
	private selectedIndex: number = 0;
	public onSelect?: (entryId: string) => void;
	public onCancel?: () => void;
	private maxVisible: number = 10; // Max messages visible

	constructor(messages: UserMessageItem[], initialSelectedId?: string) {
		// Store messages in chronological order (oldest to newest)
		this.messages = messages;
		const initialIndex = initialSelectedId ? messages.findIndex((message) => message.id === initialSelectedId) : -1;
		// Start with selected message if provided, else default to the most recent
		this.selectedIndex = initialIndex >= 0 ? initialIndex : Math.max(0, messages.length - 1);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.messages.length === 0) {
			lines.push(theme.fg("muted", "  No user messages found"));
			return lines;
		}

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.messages.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.messages.length);

		// Render visible messages (2 lines per message + blank line)
		for (let i = startIndex; i < endIndex; i++) {
			const message = this.messages[i];
			const isSelected = i === this.selectedIndex;

			// Normalize message to single line
			const normalizedMessage = message.text.replace(/\n/g, " ").trim();

			// First line: cursor + message — pad + selectedBg when focused
			const cursor = selectionCursor(isSelected);
			const maxMsgWidth = width - 2; // Account for cursor (2 chars)
			const truncatedMsg = truncateToWidth(normalizedMessage, maxMsgWidth, "…", isSelected);
			let messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);
			if (isSelected) {
				messageLine = theme.bg("selectedBg", messageLine);
			}
			lines.push(messageLine);

			// Second line: metadata (position in history)
			const position = i + 1;
			const metadata = `  Message ${position} of ${this.messages.length}`;
			lines.push(theme.fg("muted", metadata));
			lines.push(""); // Blank line between messages
		}

		const scrollHint = themedScrollPositionHint(this.selectedIndex, this.messages.length, startIndex, endIndex);
		if (scrollHint) {
			lines.push(scrollHint);
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Up arrow - go to previous (older) message, wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.messages.length - 1 : this.selectedIndex - 1;
		}
		// Down arrow - go to next (newer) message, wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.messages.length - 1 ? 0 : this.selectedIndex + 1;
		}
		// Enter - select message and branch
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.messages[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.id);
			}
		}
		// Escape - cancel
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}
}

/**
 * Component that renders a user message selector for branching
 */
export class UserMessageSelectorComponent extends Container {
	private messageList: UserMessageList;

	constructor(
		messages: UserMessageItem[],
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		initialSelectedId?: string,
	) {
		super();

		// Add header
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Fork from Message"), 1, 0));
		this.addChild(
			new Text(
				theme.fg("muted", "Select a user message to copy the active path up to that point into a new session"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const { surface: card, mount } = beginSelectorSurface(this, true);
		card.addChild(new Spacer(1));

		// Create message list
		this.messageList = new UserMessageList(messages, initialSelectedId);
		this.messageList.onSelect = onSelect;
		this.messageList.onCancel = onCancel;

		card.addChild(this.messageList);
		card.addChild(new Spacer(1));
		mount();

		// Auto-cancel if no messages
		if (messages.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	getMessageList(): UserMessageList {
		return this.messageList;
	}
}
