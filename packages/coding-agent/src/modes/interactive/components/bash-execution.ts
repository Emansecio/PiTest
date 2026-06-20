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

		// NOTE: the command header is created in updateDisplay() (which clears the
		// container on every render), so we do not build a duplicate one here.
		const headerColor = excludeFromContext ? "dim" : "bashMode";

		// Loader
		this.loader = new Loader(
			ui,
			(spinner) => theme.fg(headerColor, spinner),
			(text) => theme.fg("muted", text),
			`Running… (${keyText("tui.select.cancel")} to cancel)`,
		);
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

		// Use cached derived data for the rest of the render
		const availableLines = this.cachedAvailableLines;

		// Apply preview truncation based on expanded state
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;

		// Rebuild content container
		this.contentContainer.clear();

		// Command header — shell already provides the 1-col left inset via the
		// gutter; no internal paddingX needed. Collapsed, a long command is clamped
		// to a single visual row (horizontal clip via `…`, multi-line scripts folded
		// into `(N earlier lines, …)`); ctrl+o expands to the full command. Mirrors
		// the agent-issued bash tool's title clamp so user `!` commands don't wrap.
		// headerRenderer is a persistent field — not re-allocated every call.
		this.contentContainer.addChild(this.headerRenderer);

		// Output
		if (availableLines.length > 0) {
			if (this.expanded) {
				// Show all lines — use cached styled text (recomputed only when
				// outputVersion changes, not on every invalidate()-triggered re-render).
				this.contentContainer.addChild(new Text(this.cachedStyledExpanded, 0, 0));
			} else {
				// Use shared visual truncation utility with width-aware caching.
				// cachedStyledPreview is stable across invalidate()-only re-renders so
				// the closure captures a reference that doesn't change between them.
				const styledInput = this.cachedStyledPreview;
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;
				this.contentContainer.addChild({
					render: (width: number) => {
						if (cachedLines === undefined || cachedWidth !== width) {
							const result = truncateToVisualLines(styledInput, PREVIEW_LINES, width, 0);
							cachedLines = result.visualLines;
							cachedWidth = width;
						}
						return cachedLines ?? [];
					},
					invalidate: () => {
						cachedWidth = undefined;
						cachedLines = undefined;
					},
				});
			}
		}

		// Loader or status
		if (this.status === "running") {
			this.contentContainer.addChild(this.loader);
		} else {
			const statusParts: string[] = [];

			// Show how many lines are hidden (collapsed preview)
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

			// Add truncation warning (context truncation, not preview truncation).
			// cachedContextTruncation is always defined here: outputNeedsRefresh
			// sets it on first call; subsequent calls leave it set from before.
			const wasTruncated = this.truncationResult?.truncated || this.cachedContextTruncation?.truncated;
			if (wasTruncated && this.fullOutputPath) {
				statusParts.push(theme.fg("warning", `Output truncated. Full output: ${this.fullOutputPath}`));
			}

			if (statusParts.length > 0) {
				// Hug the command line when there's no output above (avoids an orphan
				// blank line); separate from the output only when it's present.
				const statusPrefix = availableLines.length > 0 ? "\n" : "";
				this.contentContainer.addChild(new Text(`${statusPrefix}${statusParts.join("\n")}`, 0, 0));
			}
		}
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
