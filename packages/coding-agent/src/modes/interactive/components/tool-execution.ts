import { performance } from "node:perf_hooks";
import {
	type Component,
	Container,
	getCapabilities,
	Image,
	SPINNER_FRAME_MS,
	SPINNER_FRAMES,
	Spacer,
	Text,
	type TUI,
} from "@pit/tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { allToolNames, createToolDefinition, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { interpolateFg } from "../theme/color-interpolation.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { summarizeArgsOneLine } from "./arg-summary.ts";
import { keyHint } from "./keybinding-hints.js";
import { MessageShell } from "./message-shell.ts";
import type { ToolActivity } from "./tool-activity.ts";

// Cap for the no-custom-renderer result fallback. Tools without their own
// renderResult (MCP tools, the coordinator/Task tool, extension tools) would
// otherwise dump their entire — often large — output into the CLI. Collapse to
// a preview; the full output stays reachable via the expand toggle. Mirrors the
// find/ls cap pattern.
const FALLBACK_RESULT_PREVIEW_LINES = 15;

// Tools whose collapsed result should show only the first line. The Task/subagent
// tool streams large, noisy transcripts that otherwise flood the CLI; the full
// output stays reachable via the expand toggle (ctrl+o).
const SINGLE_LINE_PREVIEW_TOOLS = new Set<string>(["task"]);

/** Duration of the gutter color fade when a tool settles pending → success/error (P5). */
const GUTTER_EASE_MS = 220;

/** Result text marking an aborted/interrupted tool (vs a real failure). Such
 * results must not auto-expand their captured output — the user chose to stop. */
const ABORT_RESULT_RE = /\b(?:command|operation|request was|stream) aborted\b|\binterrupted\b/i;

type GutterState = "pending" | "success" | "error";

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
	// Gutter animation state: the running spinner (P4) spins while the tool is
	// executing; the settle fade (P5) plays once on the pending → final switch.
	private gutterState: GutterState = "pending";
	private gutterEaseUnsub: (() => void) | null = null;
	private gutterEaseStart = 0;
	private gutterEaseTo: "success" | "error" = "success";
	private runningSpinnerUnsub: (() => void) | null = null;
	private runningSpinnerFrame = -1;
	// When true (component is a child of a NavGroup/ActivityLine), the gutter is
	// hidden and its animations are owned by the parent line — skip the local
	// gutter spinner/ease entirely.
	private gutterAnimationsEnabled = true;

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
		const previewLines = SINGLE_LINE_PREVIEW_TOOLS.has(this.toolName) ? 1 : FALLBACK_RESULT_PREVIEW_LINES;
		const maxLines = this.expanded ? lines.length : previewLines;
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

	getToolName(): string {
		return this.toolName;
	}

	getArgs(): any {
		return this.args;
	}

	getResultDetails(): any {
		return this.result?.details;
	}

	getActivityState(): "pending" | "success" | "error" {
		if (this.isPartial) return "pending";
		return this.result?.isError ? "error" : "success";
	}

	/** True when the errored result is actually an abort/interruption rather than
	 * a genuine failure — used to suppress the error auto-expand. */
	isAborted(): boolean {
		if (!this.result?.isError) return false;
		return this.result.content.some((c) => typeof c.text === "string" && ABORT_RESULT_RE.test(c.text));
	}

	getActivityFamily(): ToolActivity {
		const activity = this.toolDefinition?.activity ?? this.builtInToolDefinition?.activity;
		if (typeof activity === "function") {
			try {
				return activity(this.args);
			} catch {
				return "action";
			}
		}
		return activity ?? "action";
	}

	/** Run as a child of an activity line/group: drop the gutter and let the
	 * parent own the state icon + spinner. Idempotent. */
	setActivityChild(on: boolean): void {
		this.gutterAnimationsEnabled = !on;
		this.setShellDisabled(on);
		if (on) {
			this.stopRunningSpinner();
			this.stopGutterEase();
		}
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
		// pending → muted gray, success → green, error → red. The pending → final
		// switch eases the color (P5) rather than snapping; see refreshGutterState.
		this.refreshGutterState();

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

		this.syncRunningSpinner();
	}

	private toolGutterColor(state: GutterState): (text: string) => string {
		switch (state) {
			case "error":
				return (text: string) => theme.fg("gutterToolError", text);
			case "success":
				return (text: string) => theme.fg("gutterToolSuccess", text);
			default:
				return (text: string) => theme.fg("gutterToolPending", text);
		}
	}

	/** Decide the gutter color for the current state: ease once when settling
	 * pending → success/error (P5), otherwise set it steadily. */
	private refreshGutterState(): void {
		if (!this.gutterAnimationsEnabled) return;
		const target: GutterState = this.isPartial ? "pending" : this.result?.isError ? "error" : "success";
		if (target === this.gutterState) {
			// No state change: leave an in-flight ease alone; otherwise keep the
			// steady color (the content around it may have rebuilt).
			if (!this.gutterEaseUnsub) this.setGutterColor(this.toolGutterColor(target));
			return;
		}
		const settling = this.gutterState === "pending" && target !== "pending";
		this.gutterState = target;
		if (settling) {
			this.beginGutterEase(target);
		} else {
			this.stopGutterEase();
			this.setGutterColor(this.toolGutterColor(target));
		}
	}

	private beginGutterEase(target: "success" | "error"): void {
		// Hand the gutter back from the running spinner to the static bar first.
		this.stopRunningSpinner();
		const to: ThemeColor = target === "error" ? "gutterToolError" : "gutterToolSuccess";
		// No truecolor easing available (256-color / unparseable): snap.
		if (!interpolateFg("gutterToolPending", to, 0)) {
			this.stopGutterEase();
			this.setGutterColor(this.toolGutterColor(target));
			return;
		}
		this.stopGutterEase();
		this.gutterEaseTo = target;
		this.gutterEaseStart = performance.now();
		this.gutterEaseUnsub = this.ui.addAnimationCallback((now) => this.gutterEaseTick(now));
	}

	private gutterEaseTick(now: number): boolean {
		const target = this.gutterEaseTo;
		const to: ThemeColor = target === "error" ? "gutterToolError" : "gutterToolSuccess";
		const raw = (now - this.gutterEaseStart) / GUTTER_EASE_MS;
		const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
		const eased = t * t * (3 - 2 * t); // smoothstep
		this.setGutterColor(interpolateFg("gutterToolPending", to, eased) ?? this.toolGutterColor(target));
		if (t >= 1) {
			this.setGutterColor(this.toolGutterColor(target));
			this.stopGutterEase();
		}
		return true;
	}

	private stopGutterEase(): void {
		if (this.gutterEaseUnsub) {
			this.gutterEaseUnsub();
			this.gutterEaseUnsub = null;
		}
	}

	/** Subscribe/unsubscribe the gutter running spinner based on whether the tool
	 * is actively executing (started, not yet settled, and not mid-ease). */
	private syncRunningSpinner(): void {
		if (!this.gutterAnimationsEnabled) {
			this.stopRunningSpinner();
			return;
		}
		const running = this.executionStarted && this.isPartial && !this.hideComponent && this.gutterEaseUnsub === null;
		if (running) {
			if (!this.runningSpinnerUnsub) {
				this.runningSpinnerFrame = -1;
				this.runningSpinnerUnsub = this.ui.addAnimationCallback((now) => this.runningSpinnerTick(now));
			}
		} else {
			this.stopRunningSpinner();
		}
	}

	private runningSpinnerTick(now: number): boolean {
		const frame = Math.floor(now / SPINNER_FRAME_MS) % SPINNER_FRAMES.length;
		if (frame === this.runningSpinnerFrame) return false;
		this.runningSpinnerFrame = frame;
		this.setGutterSpinner(SPINNER_FRAMES[frame]);
		return true;
	}

	private stopRunningSpinner(): void {
		if (this.runningSpinnerUnsub) {
			this.runningSpinnerUnsub();
			this.runningSpinnerUnsub = null;
		}
		this.runningSpinnerFrame = -1;
		this.setGutterSpinner(undefined);
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
