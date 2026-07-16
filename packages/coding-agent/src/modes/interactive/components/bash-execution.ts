/**
 * Component for displaying bash command execution with streaming output.
 */

import { Container, Loader, Text, type TUI } from "@pit/tui";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { clampBashCommandRow } from "./bash-command-row.ts";
import { keyHint, keyText } from "./keybinding-hints.ts";
import { MessageShell } from "./message-shell.ts";
import { reducedMotionLoaderIndicator } from "./spinner-ticker.ts";
import { expandKeyHint, moreLinesTrailer } from "./tool-activity.ts";

import { truncateToVisualLines } from "./visual-truncate.ts";

// Preview line limit when not expanded (matches tool execution behavior)
const PREVIEW_LINES = 20;

// Rolling cap on the in-memory output buffer. A streaming command (e.g. `yes`,
// `tail -f`, a chatty build) fires appendOutput() for every child-process data
// event with no byte/rate limit on the producer side, so an uncapped
// outputLines grows to the full lifetime size of the stream → OOM in the TUI
// process. updateDisplay() already only ever feeds truncateTail the last
// DEFAULT_MAX_LINES+1 lines and shows only the last PREVIEW_LINES, and the
// untruncated output is persisted on disk via fullOutputPath, so trimming the
// head beyond this generous bound is byte-identical for the visible preview and
// the context-truncated content while keeping memory bounded.
const OUTPUT_LINES_CAP = DEFAULT_MAX_LINES * 2 + 1;

export class BashExecutionComponent extends MessageShell {
	private command: string;
	private outputLines: string[] = [];
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined = undefined;
	private loader: Loader;
	private truncationResult?: TruncationResult;
	private fullOutputPath?: string;
	private expanded = false;
	private contentContainer: Container;
	// Bumped whenever outputLines changes so context truncation can be cached
	// across re-renders that don't actually alter the output (avoids re-joining
	// and re-truncating the entire buffer on every stdout chunk → O(n²)).
	private outputVersion = 0;
	private cachedContextVersion = -1;
	private cachedContextTruncation?: TruncationResult;
	// Derived from contextTruncation; cached alongside it so invalidate()-only
	// re-renders (width change, focus, etc.) don't redo split/map on every call.
	private cachedAvailableLines: string[] = [];
	private cachedStyledPreview = "";
	private cachedStyledExpanded = "";
	// Persistent header renderer — hoisted so it is not re-allocated on every
	// updateDisplay() call. Reads this.command and this.expanded at render time.
	private readonly headerRenderer = {
		render: (width: number): string[] => {
			if (this.expanded) {
				return new Text(theme.fg("bashMode", theme.bold(`$ ${this.command}`)), 0, 0).render(width);
			}
			return [clampBashCommandRow({ command: this.command, width, colorKey: "bashMode" })];
		},
		invalidate: () => {},
	};
	// Persistent output children — patched on streaming chunks instead of
	// contentContainer.clear() + re-add on every appendOutput().
	private readonly outputExpandedText = new Text("", 0, 0);
	private previewStyledInput = "";
	private previewCachedWidth: number | undefined;
	private previewCachedLines: string[] | undefined;
	private readonly outputPreviewRenderer = {
		render: (width: number): string[] => {
			if (this.previewCachedWidth !== width) {
				const result = truncateToVisualLines(this.previewStyledInput, PREVIEW_LINES, width, 0);
				this.previewCachedLines = result.visualLines;
				this.previewCachedWidth = width;
			}
			return this.previewCachedLines ?? [];
		},
		invalidate: () => {
			this.previewCachedWidth = undefined;
			this.previewCachedLines = undefined;
		},
	};
	private readonly statusText = new Text("", 0, 0);
	private lastLayoutKey = "";

	constructor(command: string, ui: TUI, excludeFromContext = false) {
		// Per Leva 2 (D3=yes): bash uses the unified shell instead of the
		// previous DynamicBorder pair (top + bottom `─`). The role-specific
		// color moves to the gutter; `excludeFromContext` (`!!` prefix) drops
		// to dim so it's clear the command was not added to the LLM history.
		const colorKey = excludeFromContext ? "dim" : "gutterBash";
		super({ gutterColor: (text: string) => theme.fg(colorKey, text) });
		this.command = command;

		// Content container holds dynamic content (command header + output + loader).
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		const headerColor = excludeFromContext ? "dim" : "bashMode";

		// Loader — cancel hint lives in the trailing suffix (same idiom as the
		// working loader), so the body stays a clean status label (U02).
		this.loader = new Loader(
			ui,
			(spinner) => theme.fg(headerColor, spinner),
			(text) => theme.fg("muted", text),
			"Running…",
			reducedMotionLoaderIndicator(),
		);
		this.loader.setTrailingSuffix(` ·${keyText("tui.select.cancel")} to cancel`);
		// Per-command clock: a 90s test run and a 2s command should not spin
		// identically — the counter separates "slow but alive" from "stuck".
		this.loader.setElapsedEnabled(true);
		this.contentContainer.addChild(this.loader);
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	appendOutput(chunk: string): void {
		// Strip ANSI codes and normalize line endings
		// Note: binary data is already sanitized in tui-renderer.ts executeBashCommand
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		// Append to output lines
		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			// Append first chunk to last line (incomplete line continuation)
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			this.outputLines.push(...newLines.slice(1));
		} else {
			this.outputLines.push(...newLines);
		}

		// Cap the in-memory buffer to a rolling tail so a long-running streaming
		// command can't grow outputLines without bound (→ OOM). The kept tail is
		// far larger than what updateDisplay() consumes (last DEFAULT_MAX_LINES+1)
		// or shows (last PREVIEW_LINES), so this is byte-identical for the preview
		// and the context-truncated content; the full output lives on disk.
		if (this.outputLines.length > OUTPUT_LINES_CAP) {
			this.outputLines.splice(0, this.outputLines.length - OUTPUT_LINES_CAP);
		}

		// The line-count cap above does nothing when the stream emits no newlines
		// (e.g. `yes | tr -d '\n'`, a \r-redrawing progress bar, a binary blob):
		// every chunk lands in the `newLines.length === 1` continuation branch, so
		// outputLines stays length 1 and that single string grows for the whole
		// lifetime of the stream → OOM, plus updateDisplay() re-scans the giant line
		// each chunk → O(n²). Bound the trailing element to DEFAULT_MAX_BYTES by
		// trimming its head. truncateTail() in updateDisplay() already keeps only the
		// trailing DEFAULT_MAX_BYTES of the visible/context content, so head-trimming
		// is byte-identical for both; the full output is persisted on disk.
		const lastIdx = this.outputLines.length - 1;
		if (lastIdx >= 0 && this.outputLines[lastIdx].length > DEFAULT_MAX_BYTES) {
			this.outputLines[lastIdx] = this.outputLines[lastIdx].slice(-DEFAULT_MAX_BYTES);
		}

		this.outputVersion++;
		this.updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;

		// Stop loader
		this.loader.stop();

		this.updateDisplay();
	}

	private computeLayoutKey(availableLines: string[], hiddenLineCount: number, hasStatusText: boolean): string {
		return [
			this.status,
			this.expanded ? "1" : "0",
			availableLines.length > 0 ? "1" : "0",
			String(hiddenLineCount),
			hasStatusText ? "1" : "0",
		].join("|");
	}

	private buildStatusText(availableLines: string[], hiddenLineCount: number): string {
		const statusParts: string[] = [];

		if (hiddenLineCount > 0) {
			if (this.expanded) {
				statusParts.push(`(${keyHint("app.tools.expand", "to collapse")})`);
			} else {
				statusParts.push(moreLinesTrailer(hiddenLineCount, expandKeyHint()));
			}
		}

		if (this.status === "cancelled") {
			statusParts.push(theme.fg("warning", "(cancelled)"));
		} else if (this.status === "error") {
			statusParts.push(theme.fg("error", `(exit ${this.exitCode})`));
		}

		const wasTruncated = this.truncationResult?.truncated || this.cachedContextTruncation?.truncated;
		if (wasTruncated && this.fullOutputPath) {
			statusParts.push(theme.fg("warning", `Output truncated. Full output: ${this.fullOutputPath}`));
		}

		if (statusParts.length === 0) return "";
		const statusPrefix = availableLines.length > 0 ? "\n" : "";
		return `${statusPrefix}${statusParts.join("\n")}`;
	}

	private patchDisplayContent(availableLines: string[]): void {
		if (availableLines.length > 0) {
			if (this.expanded) {
				this.outputExpandedText.setText(this.cachedStyledExpanded);
			} else {
				this.previewStyledInput = this.cachedStyledPreview;
				this.outputPreviewRenderer.invalidate();
			}
		}
	}

	private rebuildDisplayContent(availableLines: string[], hiddenLineCount: number): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(this.headerRenderer);

		if (availableLines.length > 0) {
			if (this.expanded) {
				this.outputExpandedText.setText(this.cachedStyledExpanded);
				this.contentContainer.addChild(this.outputExpandedText);
			} else {
				this.previewStyledInput = this.cachedStyledPreview;
				this.outputPreviewRenderer.invalidate();
				this.contentContainer.addChild(this.outputPreviewRenderer);
			}
		}

		if (this.status === "running") {
			this.contentContainer.addChild(this.loader);
		} else {
			const statusBody = this.buildStatusText(availableLines, hiddenLineCount);
			if (statusBody.length > 0) {
				this.statusText.setText(statusBody);
				this.contentContainer.addChild(this.statusText);
			}
		}
	}

	private updateDisplay(): void {
		// Apply truncation for LLM context limits (same limits as bash tool).
		// Cache by outputVersion: re-renders triggered by invalidate()/setExpanded
		// (width changes, focus, expand toggle) don't change the buffer, so we
		// avoid re-joining + re-truncating the entire output on every render.
		// This is what turns the per-chunk cost from O(n²) into O(n) overall.
		// Check before updating whether this outputVersion is already cached.
		if (this.cachedContextTruncation === undefined || this.cachedContextVersion !== this.outputVersion) {
			// truncateTail keeps only the trailing DEFAULT_MAX_LINES/DEFAULT_MAX_BYTES,
			// so joining the whole (unbounded) buffer each chunk is O(n) waste that
			// makes streaming O(n²). The kept suffix is always within the last
			// DEFAULT_MAX_LINES lines, so feeding only the last DEFAULT_MAX_LINES+1
			// lines is byte-identical for both .content AND the .truncated flag
			// (the +1 preserves the "exceeds line limit" boundary) while bounding cost.
			const tailLines =
				this.outputLines.length > DEFAULT_MAX_LINES + 1
					? this.outputLines.slice(-(DEFAULT_MAX_LINES + 1))
					: this.outputLines;
			const freshTruncation = truncateTail(tailLines.join("\n"), {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			this.cachedContextTruncation = freshTruncation;
			this.cachedContextVersion = this.outputVersion;

			// Rebuild derived caches (split + styled maps) in the same epoch.
			// invalidate()-only re-renders skip this entire branch, reading the
			// already-cached fields below — that is what eliminates the O(n²) work.
			this.cachedAvailableLines = freshTruncation.content ? freshTruncation.content.split("\n") : [];
			const previewSlice = this.cachedAvailableLines.slice(-PREVIEW_LINES);
			this.cachedStyledPreview = previewSlice.map((line) => theme.fg("muted", line)).join("\n");
			this.cachedStyledExpanded = this.cachedAvailableLines.map((line) => theme.fg("muted", line)).join("\n");
		}

		const availableLines = this.cachedAvailableLines;
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;
		const hasStatusText =
			this.status !== "running" && this.buildStatusText(availableLines, hiddenLineCount).length > 0;
		const layoutKey = this.computeLayoutKey(availableLines, hiddenLineCount, hasStatusText);

		if (layoutKey === this.lastLayoutKey && this.contentContainer.children.length > 0) {
			this.patchDisplayContent(availableLines);
			return;
		}

		this.rebuildDisplayContent(availableLines, hiddenLineCount);
		this.lastLayoutKey = layoutKey;
	}

	/**
	 * Get the raw output for creating BashExecutionMessage.
	 */
	getOutput(): string {
		return this.outputLines.join("\n");
	}

	/**
	 * Get the command that was executed.
	 */
	getCommand(): string {
		return this.command;
	}
}
