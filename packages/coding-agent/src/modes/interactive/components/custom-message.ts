import type { TextContent } from "@pit/ai";
import type { Component } from "@pit/tui";
import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text, TruncatedText } from "@pit/tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

/**
 * Fusion flow lines (panel dispatch / member results / judge / writer) render
 * as a clean muted timeline: one plain line each, no purple box, no spacer, no
 * `[customType]` header — distinct from the default custom-message styling.
 */
const FUSION_FLOW_CUSTOM_TYPE = "pi.fusion-flow";

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private box: Box;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;

		// Fusion-flow lines are a compact timeline: no leading spacer per line.
		if (message.customType !== FUSION_FLOW_CUSTOM_TYPE) {
			this.addChild(new Spacer(1));
		}

		// Create box with purple background (used for default rendering)
		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		// Remove previous content component
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}
		this.removeChild(this.box);

		// Fusion-flow timeline: a single muted line, width-truncated, no box/header/spacer.
		if (this.message.customType === FUSION_FLOW_CUSTOM_TYPE) {
			const line = this.extractText();
			const component = new TruncatedText(theme.fg("muted", line));
			this.customComponent = component;
			this.addChild(component);
			return;
		}

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(this.message, { expanded: this._expanded }, theme);
				if (component) {
					// Custom renderer provides its own styled component
					this.customComponent = component;
					this.addChild(component);
					return;
				}
			} catch {
				// Fall through to default rendering
			}
		}

		// Default rendering uses our box
		this.addChild(this.box);
		this.box.clear();

		// Default rendering: label + content
		const label = theme.fg("customMessageLabel", `\x1b[1m[${this.message.customType}]\x1b[22m`);
		this.box.addChild(new Text(label, 0, 0));
		this.box.addChild(new Spacer(1));

		const text = this.extractText();

		this.box.addChild(
			new Markdown(text, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}

	private extractText(): string {
		if (typeof this.message.content === "string") {
			return this.message.content;
		}
		return this.message.content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	}
}
