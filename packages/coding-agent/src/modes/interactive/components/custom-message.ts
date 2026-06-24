import type { TextContent } from "@pit/ai";
import type { Component } from "@pit/tui";
import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text, TruncatedText } from "@pit/tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { FusionSummaryData, FusionSummarySynthesisItem } from "../../../core/fusion/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { truncateWithEllipsis } from "../../../utils/surrogate.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

/**
 * Fusion flow lines (panel dispatch / member results / judge / writer) render
 * as a clean muted timeline: one plain line each, no purple box, no spacer, no
 * `[customType]` header — distinct from the default custom-message styling.
 */
const FUSION_FLOW_CUSTOM_TYPE = "pit.fusion-flow";

/**
 * Fusion summary: emitted once per fusion turn with a structured JSON payload
 * describing member results, judge stats, degradation state, and optional
 * synthesis excerpts. Renders as a coloured compact timeline block.
 */
const FUSION_SUMMARY_CUSTOM_TYPE = "pit.fusion-summary";

function labelForKind(kind: FusionSummarySynthesisItem["kind"]): string {
	if (kind === "consensus") return "consensus";
	if (kind === "contradiction") return "contradiction";
	if (kind === "partial") return "partial-coverage";
	if (kind === "unique") return "unique";
	return "blind-spot";
}

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

		// Fusion-flow and fusion-summary lines are compact timeline entries: no leading spacer.
		const isFusionCompact =
			message.customType === FUSION_FLOW_CUSTOM_TYPE || message.customType === FUSION_SUMMARY_CUSTOM_TYPE;
		if (!isFusionCompact) {
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

		// Fusion-summary: structured JSON payload → multi-line coloured timeline block.
		if (this.message.customType === FUSION_SUMMARY_CUSTOM_TYPE) {
			let data: FusionSummaryData;
			try {
				data = JSON.parse(this.extractText()) as FusionSummaryData;
			} catch {
				// Graceful fallback: render raw text muted on a single line.
				const fallback = new TruncatedText(theme.fg("muted", this.extractText()));
				this.customComponent = fallback;
				this.addChild(fallback);
				return;
			}

			const container = new Container();

			// --- Main line -------------------------------------------------------
			// Member badges: ✓ (success) or ✗ (error) per member.
			const badges = data.members.map((m) => theme.fg(m.ok ? "success" : "error", m.ok ? "✓" : "✗")).join("");

			// Per-advisor elapsed (rounded to seconds), joined by ·. A leading slot
			// number disambiguates identical members (self-fusion of the same model).
			const memberParts = data.members.map((m, i) => {
				const secs = Math.round(m.elapsedMs / 1000);
				const failed = m.ok ? "" : " (failed)";
				return `${i + 1} ${m.cli} ${secs}s${failed}`;
			});

			// Compose main line segments — each pre-coloured, no outer fg wrap
			// that would overwrite semantic colours.
			let mainLine = `  ${badges}${theme.fg("muted", "  fusion  ")}${theme.fg("muted", memberParts.join(" · "))}`;

			// Judge stats (only non-zero fields).
			if (data.judge) {
				const j = data.judge;
				const judgeFields: string[] = [];
				if (j.consensus > 0) judgeFields.push(`${j.consensus} consensus`);
				if (j.contradictions > 0) judgeFields.push(`${j.contradictions} contradiction`);
				if (j.partial > 0) judgeFields.push(`${j.partial} partial`);
				if (j.unique > 0) judgeFields.push(`${j.unique} unique`);
				if (j.blindSpots > 0) judgeFields.push(`${j.blindSpots} blind-spot`);
				if (judgeFields.length > 0) {
					mainLine += theme.fg("muted", ` → judge: ${judgeFields.join(" · ")}`);
				}
			}

			// Verification stats (fact-checked against the code): confirmed/refuted/unverified.
			if (data.verification) {
				const v = data.verification;
				const vFields: string[] = [];
				if (v.confirmed > 0) vFields.push(theme.fg("success", `${v.confirmed} confirmed`));
				if (v.refuted > 0) vFields.push(theme.fg("error", `${v.refuted} refuted`));
				if (v.unverified > 0) vFields.push(theme.fg("warning", `${v.unverified} unverified`));
				if (vFields.length > 0) {
					mainLine += theme.fg("muted", " → verify: ") + vFields.join(theme.fg("muted", " · "));
				}
			}

			// Degradation signal.
			if (data.degraded === "solo-synth") {
				mainLine += theme.fg("muted", " → ") + theme.fg("warning", "solo-synth");
			} else if (data.degraded === "both-failed") {
				mainLine += theme.fg("muted", " → ") + theme.fg("error", "both failed");
			}

			// Synthesizer id.
			mainLine += theme.fg("muted", ` → ${data.synthId}`);

			container.addChild(new TruncatedText(mainLine));

			// --- Failure reasons -----------------------------------------------
			// Surface each failed advisor's cause (e.g. "Not logged in · Please run
			// /login", "timeout") so a degraded turn is self-diagnosing instead of just
			// "(failed)". Slot number keeps identical advisors distinguishable.
			data.members.forEach((m, i) => {
				if (!m.ok && m.error) {
					const reason =
						`    ` +
						theme.fg("error", `advisor ${i + 1} (${m.cli}) failed`) +
						`  ` +
						theme.fg("dim", truncateWithEllipsis(m.error, 200));
					container.addChild(new TruncatedText(reason));
				}
			});

			// --- Synthesis sub-lines -------------------------------------------
			if (data.synthesis && data.synthesis.length > 0) {
				for (const item of data.synthesis) {
					const label = labelForKind(item.kind);
					const excerpt = item.text.slice(0, 200);
					const subLine = `    ${theme.fg("muted", label)}  ${theme.fg("dim", excerpt)}`;
					container.addChild(new TruncatedText(subLine));
				}
			}

			this.customComponent = container;
			this.addChild(container);
			return;
		}

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
