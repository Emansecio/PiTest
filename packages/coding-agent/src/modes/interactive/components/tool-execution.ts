import { type Component, Container, getCapabilities, Image, Spacer, Text, type TUI } from "@pit/tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { allToolNames, createToolDefinition, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.js";
import { MessageShell } from "./message-shell.ts";

// Cap for the no-custom-renderer result fallback. Tools without their own
// renderResult (MCP tools, the coordinator/Task tool, extension tools) would
// otherwise dump their entire — often large — output into the CLI. Collapse to
// a preview; the full output stays reachable via the expand toggle. Mirrors the
// find/ls cap pattern.
const FALLBACK_RESULT_PREVIEW_LINES = 15;

// Max width of the one-line arg summary shown next to the tool name for tools
// without a custom renderCall.
const FALLBACK_CALL_SUMMARY_MAX = 80;

/**
 * Compact, single-line preview of a tool call's args for the collapsed row.
 * Scalars render as `key: value`; arrays/objects collapse to `[n]` / `{…}` so
 * a large payload (typical of MCP tools) never expands the row. The whole line
 * is clamped to FALLBACK_CALL_SUMMARY_MAX.
 */
function summarizeArgsOneLine(args: unknown, maxLen = FALLBACK_CALL_SUMMARY_MAX): string {
	const clamp = (s: string): string => (s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s);
	if (typeof args === "string") {
		return clamp(args.replace(/\s+/g, " ").trim());
	}
	if (args === null || typeof args !== "object") {
		return "";
	}
	const parts: string[] = [];
	for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
		if (v === null || v === undefined) continue;
		let val: string;
		if (typeof v === "string") val = v;
		else if (typeof v === "number" || typeof v === "boolean") val = String(v);
		else if (Array.isArray(v)) val = `[${v.length}]`;
		else val = "{…}";
		parts.push(`${k}: ${val.replace(/\s+/g, " ").trim()}`);
		// Stop once we already overflow — no point formatting the tail.
		if (parts.join("  ").length >= maxLen) break;
	}
	return clamp(parts.join("  "));
}

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

export class ToolExecutionComponent extends MessageShell {
	private contentBox: Container;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private imageKeys: string[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super({
			gutterColor: (text: string) => theme.fg("gutterToolPending", text),
		});
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		// Build only this tool's definition (when it is a known built-in) instead
		// of constructing the entire definition map and discarding all but one
		// entry — this runs once per tool-call row mounted. MCP/extension tools
		// aren't in the registry, so they fall through to `undefined` exactly as
		// the previous map-index miss did.
		this.builtInToolDefinition = allToolNames.has(toolName as ToolName)
			? createToolDefinition(toolName as ToolName, cwd)
			: undefined;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		// Per Leva 2 (D1=B): the inner content has NO background fill. The
		// MessageShell handles all framing via the left gutter; the inner
		// containers are plain `Container`s that just stack components.
		this.contentBox = new Container();
		this.contentText = new Text("", 0, 0);
		this.selfRenderContainer = new Container();

		// `renderShell:"self"` opts the tool entirely out of the shell — used
		// by built-in `edit` / `edit-hashline` and any extension tool that
		// owns its full visual. The shell then becomes a passthrough.
		const usesSelfShell = this.hasRendererDefinition() && this.getRenderShell() === "self";
		if (usesSelfShell) {
			this.setShellDisabled(true);
		}

		if (this.hasRendererDefinition()) {
			this.addChild(usesSelfShell ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		// Tools without a custom renderCall (MCP tools, the coordinator/Task
		// tool, extension tools) would otherwise show only the bare tool name,
		// hiding the args that say what the call is actually doing. Append a
		// compact one-line arg summary so the collapsed row stays informative
		// without flooding the CLI.
		const title = theme.fg("toolTitle", theme.bold(this.toolName));
		const summary = summarizeArgsOneLine(this.args);
		const text = summary ? `${title} ${theme.fg("toolOutput", summary)}` : title;
		return new Text(text, 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const text = this.buildCappedOutput(this.getTextOutput());
		if (text === null) {
			return undefined;
		}
		return new Text(text, 0, 0);
	}

	// Collapse raw tool output to a preview unless expanded. Shared by the
	// no-renderer result fallback and formatToolExecution. Returns null when
	// there is nothing to show.
	private buildCappedOutput(rawOutput: string): string | null {
		const output = rawOutput.trim();
		if (!output) {
			return null;
		}
		const lines = output.split("\n");
		const maxLines = this.expanded ? lines.length : FALLBACK_RESULT_PREVIEW_LINES;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
		return text;
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		return super.render(width);
	}

	private updateDisplay(): void {
		// Per Leva 2: state is reflected in the gutter color, not in a bg fill.
		// pending → muted gray, success → green, error → red.
		const gutterFn = this.isPartial
			? (text: string) => theme.fg("gutterToolPending", text)
			: this.result?.isError
				? (text: string) => theme.fg("gutterToolError", text)
				: (text: string) => theme.fg("gutterToolSuccess", text);
		this.setGutterColor(gutterFn);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createCallFallback());
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		// Build the list of desired images (data + mimeType + width). `Image` has no
		// setter to mutate its source, so reuse is keyed on identity: only tear down
		// and recreate when the desired set differs from what is mounted. This avoids
		// re-decoding identical images on every args delta / updateDisplay() call.
		const desired: Array<{ key: string; data: string; mimeType: string }> = [];
		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;
					desired.push({
						key: `${imageMimeType}|${this.imageWidthCells}|${imageData}`,
						data: imageData,
						mimeType: imageMimeType,
					});
				}
			}
		}

		const keysUnchanged =
			desired.length === this.imageKeys.length && desired.every((d, idx) => d.key === this.imageKeys[idx]);

		if (!keysUnchanged) {
			for (const img of this.imageComponents) {
				this.removeChild(img);
			}
			this.imageComponents = [];
			for (const spacer of this.imageSpacers) {
				this.removeChild(spacer);
			}
			this.imageSpacers = [];

			for (const d of desired) {
				const spacer = new Spacer(1);
				this.addChild(spacer);
				this.imageSpacers.push(spacer);
				const imageComponent = new Image(
					d.data,
					d.mimeType,
					{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
					{ maxWidthCells: this.imageWidthCells },
				);
				this.imageComponents.push(imageComponent);
				this.addChild(imageComponent);
			}
			this.imageKeys = desired.map((d) => d.key);
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		// Collapsed: a one-line arg summary. Expanded: the full pretty JSON.
		if (this.expanded) {
			const content = JSON.stringify(this.args, null, 2);
			if (content && content !== "{}" && content !== "null") {
				text += `\n\n${content}`;
			}
		} else {
			const summary = summarizeArgsOneLine(this.args);
			if (summary) {
				text += ` ${theme.fg("toolOutput", summary)}`;
			}
		}
		const output = this.buildCappedOutput(this.getTextOutput());
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
