import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { promisify } from "node:util";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@pit/tui";
import { KeybindingsManager } from "../../../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../../../core/session-manager.ts";
import { canonicalizePath as _canonicalizePath } from "../../../utils/paths.ts";
import { formatDisplayPath } from "../display-utils.ts";
import { theme } from "../theme/theme.ts";
import { keyHint, keyText, selectionCursor, themedScrollPositionHint } from "./keybinding-hints.ts";
import { paintSelectedRow } from "./selectable-row.ts";
import { beginSelectorSurface } from "./selector-surface.ts";
import { filterAndSortSessions, hasSessionName, type NameFilter, type SortMode } from "./session-selector-search.ts";

type SessionScope = "current" | "all";

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

function formatSessionDate(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

function canonicalizePath(path: string | undefined): string | undefined {
	if (!path) return path;
	return _canonicalizePath(path);
}

class SessionSelectorHeader implements Component {
	private scope: SessionScope;
	private sortMode: SortMode;
	private nameFilter: NameFilter;
	private requestRender: () => void;
	private loading = false;
	private loadProgress: { loaded: number; total: number } | null = null;
	private showPath = false;
	private confirmingDeletePath: string | null = null;
	private statusMessage: { type: "info" | "error"; message: string } | null = null;
	private statusTimeout: ReturnType<typeof setTimeout> | null = null;
	private showRenameHint = false;

	constructor(scope: SessionScope, sortMode: SortMode, nameFilter: NameFilter, requestRender: () => void) {
		this.scope = scope;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.requestRender = requestRender;
	}

	setScope(scope: SessionScope): void {
		this.scope = scope;
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
	}

	setLoading(loading: boolean): void {
		this.loading = loading;
		// Progress is scoped to the current load; clear whenever the loading state is set
		this.loadProgress = null;
	}

	setProgress(loaded: number, total: number): void {
		this.loadProgress = { loaded, total };
	}

	setShowPath(showPath: boolean): void {
		this.showPath = showPath;
	}

	setShowRenameHint(show: boolean): void {
		this.showRenameHint = show;
	}

	setConfirmingDeletePath(path: string | null): void {
		this.confirmingDeletePath = path;
	}

	private clearStatusTimeout(): void {
		if (!this.statusTimeout) return;
		clearTimeout(this.statusTimeout);
		this.statusTimeout = null;
	}

	setStatusMessage(msg: { type: "info" | "error"; message: string } | null, autoHideMs?: number): void {
		this.clearStatusTimeout();
		this.statusMessage = msg;
		if (!msg || !autoHideMs) return;

		this.statusTimeout = setTimeout(() => {
			this.statusMessage = null;
			this.statusTimeout = null;
			this.requestRender();
		}, autoHideMs);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const title = this.scope === "current" ? "Resume Session (Current Folder)" : "Resume Session (All)";
		const leftText = theme.bold(title);

		const sortLabel = this.sortMode === "threaded" ? "Threaded" : this.sortMode === "recent" ? "Recent" : "Fuzzy";
		const sortText = theme.fg("muted", "Sort: ") + theme.fg("accent", sortLabel);

		const nameLabel = this.nameFilter === "all" ? "All" : "Named";
		const nameText = theme.fg("muted", "Name: ") + theme.fg("accent", nameLabel);

		let scopeText: string;
		if (this.loading) {
			const progressText = this.loadProgress ? `${this.loadProgress.loaded}/${this.loadProgress.total}` : "…";
			const scopeLabel = this.scope === "current" ? "Current Folder" : "All";
			scopeText = theme.fg("accent", `Loading ${scopeLabel} ${progressText}`);
		} else if (this.scope === "current") {
			scopeText = `${theme.fg("accent", "◉ Current Folder")}${theme.fg("muted", " | ○ All")}`;
		} else {
			scopeText = `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", "◉ All")}`;
		}

		const rightText = truncateToWidth(`${scopeText}  ${nameText}  ${sortText}`, width, "");
		const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
		const left = truncateToWidth(leftText, availableLeft, "");
		const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(rightText));

		const titleLine = `${left}${" ".repeat(spacing)}${rightText}`;

		// Transient states (delete confirmation, status/error) own the hint row; the
		// default browsing state renders a single consolidated dim key-hint line
		// (post de-clutter pass — previously two permanent hint lines).
		let hintLine: string;
		if (this.confirmingDeletePath !== null) {
			const confirmHint = `Delete session? ${keyHint("tui.select.confirm", "confirm")} · ${keyHint("tui.select.cancel", "cancel")}`;
			hintLine = theme.fg("error", truncateToWidth(confirmHint, width, "…"));
		} else if (this.statusMessage) {
			const color = this.statusMessage.type === "error" ? "error" : "accent";
			hintLine = theme.fg(color, truncateToWidth(this.statusMessage.message, width, "…"));
		} else {
			const pathState = this.showPath ? "(on)" : "(off)";
			const sep = theme.fg("muted", " · ");
			const parts = [
				keyHint("tui.input.tab", "scope"),
				keyHint("app.session.toggleSort", "sort"),
				keyHint("app.session.toggleNamedFilter", "named"),
				keyHint("app.session.delete", "delete"),
				keyHint("app.session.togglePath", `path ${pathState}`),
			];
			if (this.showRenameHint) {
				parts.push(keyHint("app.session.rename", "rename"));
			}
			// Search-syntax help trails the keys so a narrow terminal truncates it first.
			parts.push(theme.fg("muted", 're:<pattern> regex · "phrase" exact'));
			hintLine = truncateToWidth(parts.join(sep), width, "…");
		}

		return [titleLine, hintLine];
	}
}

/** A session tree node for hierarchical display */
interface SessionTreeNode {
	session: SessionInfo;
	children: SessionTreeNode[];
}

/** Flattened node for display with tree structure info */
interface FlatSessionNode {
	session: SessionInfo;
	depth: number;
	isLast: boolean;
	/** For each ancestor level, whether there are more siblings after it */
	ancestorContinues: boolean[];
}

/**
 * Build a tree structure from sessions based on parentSessionPath.
 * Returns root nodes sorted by modified date (descending).
 *
 * Self-parents and parent cycles are treated as roots so sessions stay visible
 * and flatten/sort cannot infinite-loop on a cyclic child graph.
 */
function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
	const byPath = new Map<string, SessionTreeNode>();

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		byPath.set(sessionPath, { session, children: [] });
	}

	const roots: SessionTreeNode[] = [];
	const parentOf = new Map<string, string>();

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		const node = byPath.get(sessionPath)!;
		const parentPath = canonicalizePath(session.parentSessionPath);

		if (!parentPath || parentPath === sessionPath || !byPath.has(parentPath)) {
			roots.push(node);
			continue;
		}

		// Walk existing parent links; if attaching would close a cycle, keep as root.
		let cursor: string | undefined = parentPath;
		let cyclic = false;
		const seen = new Set<string>([sessionPath]);
		while (cursor) {
			if (seen.has(cursor)) {
				cyclic = true;
				break;
			}
			seen.add(cursor);
			cursor = parentOf.get(cursor);
		}
		if (cyclic) {
			roots.push(node);
			continue;
		}

		parentOf.set(sessionPath, parentPath);
		byPath.get(parentPath)!.children.push(node);
	}

	// Sort children and roots by modified date (descending). visited guards
	// against any residual child-graph cycle from duplicate path collisions.
	const sortNodes = (nodes: SessionTreeNode[], visited: Set<SessionTreeNode>): void => {
		nodes.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
		for (const node of nodes) {
			if (visited.has(node)) continue;
			visited.add(node);
			sortNodes(node.children, visited);
		}
	};
	sortNodes(roots, new Set());

	return roots;
}

/**
 * Flatten tree into display list with tree structure metadata.
 */
function flattenSessionTree(roots: SessionTreeNode[]): FlatSessionNode[] {
	const result: FlatSessionNode[] = [];
	const visited = new Set<SessionTreeNode>();

	const walk = (node: SessionTreeNode, depth: number, ancestorContinues: boolean[], isLast: boolean): void => {
		if (visited.has(node)) return;
		visited.add(node);
		result.push({ session: node.session, depth, isLast, ancestorContinues });

		for (let i = 0; i < node.children.length; i++) {
			const childIsLast = i === node.children.length - 1;
			// Only show continuation line for non-root ancestors
			const continues = depth > 0 ? !isLast : false;
			walk(node.children[i]!, depth + 1, [...ancestorContinues, continues], childIsLast);
		}
	};

	for (let i = 0; i < roots.length; i++) {
		walk(roots[i]!, 0, [], i === roots.length - 1);
	}

	return result;
}

/**
 * Custom session list component with multi-line items and search
 */
class SessionList implements Component, Focusable {
	public getSelectedSessionPath(): string | undefined {
		const selected = this.filteredSessions[this.selectedIndex];
		return selected?.session.path;
	}
	private allSessions: SessionInfo[] = [];
	private filteredSessions: FlatSessionNode[] = [];
	private selectedIndex: number = 0;
	private searchInput: Input;
	private showCwd = false;
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private keybindings: KeybindingsManager;
	private showPath = false;
	private confirmingDeletePath: string | null = null;
	private currentSessionCanonicalPath?: string;
	public onSelect?: (sessionPath: string) => void;
	public onCancel?: () => void;
	public onExit: () => void = () => {};
	public onToggleScope?: () => void;
	public onToggleSort?: () => void;
	public onToggleNameFilter?: () => void;
	public onTogglePath?: (showPath: boolean) => void;
	public onDeleteConfirmationChange?: (path: string | null) => void;
	public onDeleteSession?: (sessionPath: string) => Promise<void>;
	public onRenameSession?: (sessionPath: string) => void;
	public onError?: (message: string) => void;
	/** Invoked after a debounced filterSessions() lands outside handleInput, so the
	 * owner can schedule a repaint. Synchronous filter paths (flushPendingFilter and
	 * direct filterSessions in handleInput) don't need this. */
	public onFilterApplied?: () => void;
	private maxVisible: number = 10; // Max sessions visible (one line each)
	private filterDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	private filterPending = false;
	// Async session load in flight (mirrors the header's loading flag): while
	// true with an empty list, the body shows "Loading sessions…" instead of
	// the empty-state advice, so the two never contradict each other.
	private loading = false;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		sessions: SessionInfo[],
		showCwd: boolean,
		sortMode: SortMode,
		nameFilter: NameFilter,
		keybindings: KeybindingsManager,
		currentSessionFilePath?: string,
	) {
		this.allSessions = sessions;
		this.filteredSessions = [];
		this.searchInput = new Input({
			placeholder: 'Search sessions — re:regex, "phrase"',
			placeholderColor: (t) => theme.fg("dim", t),
		});
		this.showCwd = showCwd;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.keybindings = keybindings;
		this.currentSessionCanonicalPath = canonicalizePath(currentSessionFilePath);
		this.filterSessions("");

		// Handle Enter in search input - select current item
		this.searchInput.onSubmit = () => {
			if (this.filteredSessions[this.selectedIndex]) {
				const selected = this.filteredSessions[this.selectedIndex];
				if (this.onSelect) {
					this.onSelect(selected.session.path);
				}
			}
		};
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
		this.filterSessions(this.searchInput.getValue());
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
		this.filterSessions(this.searchInput.getValue());
	}

	setSessions(sessions: SessionInfo[], showCwd: boolean): void {
		this.allSessions = sessions;
		this.showCwd = showCwd;
		this.filterSessions(this.searchInput.getValue());
	}

	/** Adaptive visible-row count (see SessionSelectorComponent's `tui` param). */
	setMaxVisible(maxVisible: number): void {
		this.maxVisible = maxVisible;
	}

	/** Mirror the header's loading flag so the body's empty state stays honest. */
	setLoading(loading: boolean): void {
		this.loading = loading;
	}

	private scheduleFilterSessions(query: string): void {
		this.filterPending = true;
		if (this.filterDebounceTimer !== undefined) {
			clearTimeout(this.filterDebounceTimer);
		}
		this.filterDebounceTimer = setTimeout(() => {
			this.filterDebounceTimer = undefined;
			this.filterPending = false;
			this.filterSessions(query);
			this.onFilterApplied?.();
		}, 75);
	}

	/** Apply a pending debounced filter synchronously, so navigation/selection
	 * never acts on a list that's stale relative to the last keystroke. */
	private flushPendingFilter(): void {
		if (this.filterDebounceTimer === undefined) return;
		clearTimeout(this.filterDebounceTimer);
		this.filterDebounceTimer = undefined;
		if (this.filterPending) {
			this.filterPending = false;
			this.filterSessions(this.searchInput.getValue());
		}
	}

	private filterSessions(query: string): void {
		const trimmed = query.trim();
		const nameFiltered =
			this.nameFilter === "all" ? this.allSessions : this.allSessions.filter((session) => hasSessionName(session));

		if (this.sortMode === "threaded" && !trimmed) {
			// Threaded mode without search: show tree structure
			const roots = buildSessionTree(nameFiltered);
			this.filteredSessions = flattenSessionTree(roots);
		} else {
			// Other modes or with search: flat list
			const filtered = filterAndSortSessions(nameFiltered, query, this.sortMode, "all");
			this.filteredSessions = filtered.map((session) => ({
				session,
				depth: 0,
				isLast: true,
				ancestorContinues: [],
			}));
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredSessions.length - 1));
	}

	private setConfirmingDeletePath(path: string | null): void {
		this.confirmingDeletePath = path;
		this.onDeleteConfirmationChange?.(path);
	}

	private startDeleteConfirmationForSelectedSession(): void {
		const selected = this.filteredSessions[this.selectedIndex];
		if (!selected) return;

		// Prevent deleting current session
		if (this.isCurrentSessionPath(selected.session.path)) {
			this.onError?.("Cannot delete the currently active session");
			return;
		}

		this.setConfirmingDeletePath(selected.session.path);
	}

	private isCurrentSessionPath(path: string): boolean {
		if (!this.currentSessionCanonicalPath) return false;
		return (canonicalizePath(path) ?? path) === this.currentSessionCanonicalPath;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		// Render search input
		lines.push(...this.searchInput.render(width));
		lines.push(""); // Blank line after search

		if (this.filteredSessions.length === 0) {
			// While the async load is in flight the list is empty because nothing
			// has arrived yet — advising "Press Tab to view all" would contradict
			// the header's "Loading…" and invite wrong moves.
			if (this.loading) {
				lines.push(theme.fg("muted", "  Loading sessions…"));
				return lines;
			}
			let emptyMessage: string;
			if (this.nameFilter === "named") {
				const toggleKey = keyText("app.session.toggleNamedFilter");
				if (this.showCwd) {
					emptyMessage = `  No named sessions found. Press ${toggleKey} to show all.`;
				} else {
					emptyMessage = `  No named sessions in current folder. Press ${toggleKey} to show all, or Tab to view all.`;
				}
			} else if (this.showCwd) {
				// "All" scope - no sessions anywhere that match filter
				emptyMessage = "  No sessions found";
			} else {
				// "Current folder" scope - hint to try "all"
				emptyMessage = "  No sessions in current folder. Press Tab to view all.";
			}
			lines.push(theme.fg("muted", truncateToWidth(emptyMessage, width, "…")));
			return lines;
		}

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredSessions.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredSessions.length);

		// Render visible sessions (one line each with tree structure)
		for (let i = startIndex; i < endIndex; i++) {
			const node = this.filteredSessions[i]!;
			const session = node.session;
			const isSelected = i === this.selectedIndex;
			const isConfirmingDelete = session.path === this.confirmingDeletePath;
			const isCurrent = this.isCurrentSessionPath(session.path);

			// Build tree prefix
			const prefix = this.buildTreePrefix(node);

			// Session display text (name or first message)
			const hasName = !!session.name;
			const displayText = session.name ?? session.firstMessage;
			const normalizedMessage = displayText.replace(/[\x00-\x1f\x7f]/g, " ").trim();

			// Right side: message count and age
			const age = formatSessionDate(session.modified);
			const msgCount = String(session.messageCount);
			let rightPart = `${msgCount} ${age}`;
			if (this.showCwd && session.cwd) {
				rightPart = `${formatDisplayPath(session.cwd)} ${rightPart}`;
			}
			if (this.showPath) {
				rightPart = `${formatDisplayPath(session.path)} ${rightPart}`;
			}

			// Cursor
			const cursor = selectionCursor(isSelected);

			// Calculate available width for message
			const prefixWidth = visibleWidth(prefix);
			const rightWidth = visibleWidth(rightPart) + 2; // +2 for spacing
			const availableForMsg = width - 2 - prefixWidth - rightWidth; // -2 for cursor

			const truncatedMsg = truncateToWidth(normalizedMessage, Math.max(10, availableForMsg), "…");

			// Style message
			let messageColor: "error" | "warning" | "accent" | null = null;
			if (isConfirmingDelete) {
				messageColor = "error";
			} else if (isCurrent) {
				messageColor = "accent";
			} else if (hasName) {
				messageColor = "warning";
			}
			let styledMsg = messageColor ? theme.fg(messageColor, truncatedMsg) : truncatedMsg;
			if (isSelected) {
				styledMsg = theme.bold(styledMsg);
			}

			// Build line
			const leftPart = cursor + theme.fg("dim", prefix) + styledMsg;
			const leftWidth = visibleWidth(leftPart);
			const spacing = Math.max(1, width - leftWidth - visibleWidth(rightPart));
			const styledRight = theme.fg(isConfirmingDelete ? "error" : "dim", rightPart);

			lines.push(paintSelectedRow(leftPart + " ".repeat(spacing) + styledRight, width, isSelected));
		}

		// Add scroll indicator if needed
		const scrollHint = themedScrollPositionHint(
			this.selectedIndex,
			this.filteredSessions.length,
			startIndex,
			endIndex,
		);
		if (scrollHint) {
			lines.push(truncateToWidth(scrollHint, width, ""));
		}

		return lines;
	}

	private buildTreePrefix(node: FlatSessionNode): string {
		if (node.depth === 0) {
			return "";
		}

		const parts = node.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
		const branch = node.isLast ? "└─ " : "├─ ";
		return parts.join("") + branch;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		// Handle delete confirmation state first - intercept all keys
		if (this.confirmingDeletePath !== null) {
			if (kb.matches(keyData, "tui.select.confirm")) {
				const pathToDelete = this.confirmingDeletePath;
				this.setConfirmingDeletePath(null);
				void this.onDeleteSession?.(pathToDelete);
				return;
			}
			if (kb.matches(keyData, "tui.select.cancel")) {
				this.setConfirmingDeletePath(null);
				return;
			}
			// Ignore all other keys while confirming
			return;
		}

		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.onToggleScope) {
				this.onToggleScope();
			}
			return;
		}

		if (kb.matches(keyData, "app.session.toggleSort")) {
			this.onToggleSort?.();
			return;
		}

		if (this.keybindings.matches(keyData, "app.session.toggleNamedFilter")) {
			this.onToggleNameFilter?.();
			return;
		}

		// Ctrl+P: toggle path display
		if (kb.matches(keyData, "app.session.togglePath")) {
			this.showPath = !this.showPath;
			this.onTogglePath?.(this.showPath);
			return;
		}

		// Ctrl+D: initiate delete confirmation (useful on terminals that don't distinguish Ctrl+Backspace from Backspace)
		if (kb.matches(keyData, "app.session.delete")) {
			this.startDeleteConfirmationForSelectedSession();
			return;
		}

		// Rename selected session
		if (kb.matches(keyData, "app.session.rename")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected) {
				this.onRenameSession?.(selected.session.path);
			}
			return;
		}

		// Ctrl+Backspace: non-invasive convenience alias for delete
		// Only triggers deletion when the query is empty; otherwise it is forwarded to the input
		if (kb.matches(keyData, "app.session.deleteNoninvasive")) {
			if (this.searchInput.getValue().length > 0) {
				this.searchInput.handleInput(keyData);
				this.filterSessions(this.searchInput.getValue());
				return;
			}

			this.startDeleteConfirmationForSelectedSession();
			return;
		}

		// Up arrow — wraps to the end at the top (list convention: SelectList,
		// model-selector, tree and ask-picker all wrap; Home/End cover jumps).
		if (kb.matches(keyData, "tui.select.up")) {
			this.flushPendingFilter();
			const count = this.filteredSessions.length;
			if (count > 0) this.selectedIndex = (this.selectedIndex - 1 + count) % count;
		}
		// Down arrow — wraps to the top at the end.
		else if (kb.matches(keyData, "tui.select.down")) {
			this.flushPendingFilter();
			const count = this.filteredSessions.length;
			if (count > 0) this.selectedIndex = (this.selectedIndex + 1) % count;
		}
		// Page up - jump up by maxVisible items
		else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.flushPendingFilter();
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
		}
		// Page down - jump down by maxVisible items
		else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.flushPendingFilter();
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + this.maxVisible);
		}
		// Home - jump to first item (clamped, no wrap)
		else if (kb.matches(keyData, "tui.select.home")) {
			this.flushPendingFilter();
			this.selectedIndex = 0;
		}
		// End - jump to last item (clamped, no wrap)
		else if (kb.matches(keyData, "tui.select.end")) {
			this.flushPendingFilter();
			this.selectedIndex = Math.max(0, this.filteredSessions.length - 1);
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			this.flushPendingFilter();
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.session.path);
			}
		}
		// Escape - two-step in the normal browsing state: a non-empty search is
		// cleared first, and only a second Esc (empty search) cancels/closes.
		// (Delete-confirmation and rename-mode Escapes are intercepted earlier and
		// never reach here.)
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.searchInput.getValue().length > 0) {
				this.flushPendingFilter();
				this.searchInput.setValue("");
				this.filterSessions("");
				this.onFilterApplied?.();
			} else if (this.onCancel) {
				this.onCancel();
			}
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.scheduleFilterSessions(this.searchInput.getValue());
		}
	}
}

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/** Fail-safe so a hung SessionManager.list / listAll cannot leave the picker on Loading forever. */
const SESSION_LIST_LOAD_TIMEOUT_MS = 20_000;

function withSessionListTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`${label} timed out after ${SESSION_LIST_LOAD_TIMEOUT_MS / 1000}s`));
		}, SESSION_LIST_LOAD_TIMEOUT_MS);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink
 */
async function deleteSessionFile(
	sessionPath: string,
): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
	// Try `trash` first (if installed). Run it off the render thread via an awaited
	// promisified execFile so a slow/hung `trash` binary never freezes the TUI.
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	let trashOk = false;
	let trashSpawnError: string | null = null;
	let trashStderr = "";
	try {
		await promisify(execFile)("trash", trashArgs, { encoding: "utf-8" });
		trashOk = true;
	} catch (err) {
		// execFile rejects on spawn failure (e.g. ENOENT) and on non-zero exit.
		const e = err as { message?: string; code?: unknown; stderr?: string };
		if (typeof e.stderr === "string") {
			trashStderr = e.stderr;
		}
		// spawnSync only populated `.error` on a spawn failure (string `code` such as
		// "ENOENT"), not on a non-zero exit; mirror that so the hint stays identical.
		if (typeof e.code === "string") {
			trashSpawnError = e.message ?? String(err);
		}
	}

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashSpawnError) {
			parts.push(trashSpawnError);
		}
		const stderr = trashStderr.trim();
		if (stderr) {
			parts.push(stderr.split("\n")[0] ?? stderr);
		}
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" · ").slice(0, 200)}`;
	};

	// If trash reports success, or the file is gone afterwards, treat it as successful
	if (trashOk || !existsSync(sessionPath)) {
		return { ok: true, method: "trash" };
	}

	// Fallback to permanent deletion
	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, method: "unlink", error };
	}
}

/**
 * Component that renders a session selector
 */
export class SessionSelectorComponent extends Container implements Focusable {
	handleInput(data: string): void {
		if (this.mode === "rename") {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.cancel")) {
				this.exitRenameMode();
				return;
			}
			this.renameInput.handleInput(data);
			return;
		}

		this.sessionList.handleInput(data);
	}

	private canRename = true;
	private sessionList: SessionList;
	private header: SessionSelectorHeader;
	private keybindings: KeybindingsManager;
	private scope: SessionScope = "current";
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private currentSessions: SessionInfo[] | null = null;
	private allSessions: SessionInfo[] | null = null;
	private currentSessionsLoader: SessionsLoader;
	private allSessionsLoader: SessionsLoader;
	private onCancel: () => void;
	private requestRender: () => void;
	private renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
	private currentLoading = false;
	private allLoading = false;
	private allLoadSeq = 0;
	private currentLoadSeq = 0;

	private mode: "list" | "rename" = "list";
	private renameInput = new Input();
	private renameTargetPath: string | null = null;

	// Focusable implementation - propagate to sessionList for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.sessionList.focused = value;
		this.renameInput.focused = value;
		if (value && this.mode === "rename") {
			this.renameInput.focused = true;
		}
	}

	private buildBaseLayout(content: Component, options?: { showHeader?: boolean }): void {
		this.clear();
		// Default cardBorder like every other selector — accent borders are
		// reserved for genuinely special surfaces (announcements), and /resume
		// is routine chrome.
		const { surface: card, mount } = beginSelectorSurface(this, true);
		card.addChild(new Spacer(1));
		if (options?.showHeader ?? true) {
			card.addChild(this.header);
			card.addChild(new Spacer(1));
		}
		card.addChild(content);
		card.addChild(new Spacer(1));
		mount();
	}

	constructor(
		currentSessionsLoader: SessionsLoader,
		allSessionsLoader: SessionsLoader,
		onSelect: (sessionPath: string) => void,
		onCancel: () => void,
		onExit: () => void,
		requestRender: () => void,
		options?: {
			renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
			showRenameHint?: boolean;
			keybindings?: KeybindingsManager;
		},
		currentSessionFilePath?: string,
		// Trailing/optional (theme-selector precedent): when provided, the visible-row
		// window adapts to terminal height. Existing call sites/tests that omit it keep
		// the hardcoded fallback.
		tui?: TUI,
	) {
		super();
		this.keybindings = options?.keybindings ?? KeybindingsManager.create();
		this.currentSessionsLoader = currentSessionsLoader;
		this.allSessionsLoader = allSessionsLoader;
		this.onCancel = onCancel;
		this.requestRender = requestRender;
		this.header = new SessionSelectorHeader(this.scope, this.sortMode, this.nameFilter, this.requestRender);
		const renameSession = options?.renameSession;
		this.renameSession = renameSession;
		this.canRename = !!renameSession;
		this.header.setShowRenameHint(options?.showRenameHint ?? this.canRename);

		// Create session list (starts empty, will be populated after load)
		this.sessionList = new SessionList(
			[],
			false,
			this.sortMode,
			this.nameFilter,
			this.keybindings,
			currentSessionFilePath,
		);
		this.sessionList.onFilterApplied = () => this.requestRender();

		// Adaptive height: size the window to the terminal, clamped, falling back to
		// SessionList's built-in constant when no TUI is reachable.
		if (tui) {
			this.sessionList.setMaxVisible(clamp(tui.terminal.rows - 12, 5, 15));
		}

		this.buildBaseLayout(this.sessionList);

		this.renameInput.onSubmit = (value) => {
			void this.confirmRename(value);
		};

		// Ensure header status timeouts are cleared when leaving the selector
		const clearStatusMessage = () => this.header.setStatusMessage(null);
		this.sessionList.onSelect = (sessionPath) => {
			clearStatusMessage();
			onSelect(sessionPath);
		};
		this.sessionList.onCancel = () => {
			clearStatusMessage();
			onCancel();
		};
		this.sessionList.onExit = () => {
			clearStatusMessage();
			onExit();
		};
		this.sessionList.onToggleScope = () => this.toggleScope();
		this.sessionList.onToggleSort = () => this.toggleSortMode();
		this.sessionList.onToggleNameFilter = () => this.toggleNameFilter();
		this.sessionList.onRenameSession = (sessionPath) => {
			if (!renameSession) return;
			if (this.scope === "current" && this.currentLoading) return;
			if (this.scope === "all" && this.allLoading) return;

			const sessions = this.scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
			const session = sessions.find((s) => s.path === sessionPath);
			this.enterRenameMode(sessionPath, session?.name);
		};

		// Sync list events to header
		this.sessionList.onTogglePath = (showPath) => {
			this.header.setShowPath(showPath);
			this.requestRender();
		};
		this.sessionList.onDeleteConfirmationChange = (path) => {
			this.header.setConfirmingDeletePath(path);
			this.requestRender();
		};
		this.sessionList.onError = (msg) => {
			this.header.setStatusMessage({ type: "error", message: msg }, 3000);
			this.requestRender();
		};

		// Handle session deletion
		this.sessionList.onDeleteSession = async (sessionPath: string) => {
			const result = await deleteSessionFile(sessionPath);

			if (result.ok) {
				if (this.currentSessions) {
					this.currentSessions = this.currentSessions.filter((s) => s.path !== sessionPath);
				}
				if (this.allSessions) {
					this.allSessions = this.allSessions.filter((s) => s.path !== sessionPath);
				}

				const sessions = this.scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
				const showCwd = this.scope === "all";
				this.sessionList.setSessions(sessions, showCwd);

				const msg = result.method === "trash" ? "Session moved to trash" : "Session deleted";
				this.header.setStatusMessage({ type: "info", message: msg }, 2000);
				await this.refreshSessionsAfterMutation();
			} else {
				const errorMessage = result.error ?? "Unknown error";
				this.header.setStatusMessage({ type: "error", message: `Failed to delete: ${errorMessage}` }, 3000);
			}

			this.requestRender();
		};

		// Start loading current sessions immediately
		this.loadCurrentSessions();
	}

	private loadCurrentSessions(): void {
		void this.loadScope("current", "initial");
	}

	private enterRenameMode(sessionPath: string, currentName: string | undefined): void {
		this.mode = "rename";
		this.renameTargetPath = sessionPath;
		this.renameInput.setValue(currentName ?? "");
		this.renameInput.focused = true;

		const panel = new Container();
		panel.addChild(new Text(theme.bold("Rename Session"), 1, 0));
		panel.addChild(new Spacer(1));
		panel.addChild(this.renameInput);
		panel.addChild(new Spacer(1));
		panel.addChild(
			new Text(
				theme.fg("muted", `${keyText("tui.select.confirm")} to save · ${keyText("tui.select.cancel")} to cancel`),
				1,
				0,
			),
		);

		this.buildBaseLayout(panel, { showHeader: false });
		this.requestRender();
	}

	private exitRenameMode(): void {
		this.mode = "list";
		this.renameTargetPath = null;

		this.buildBaseLayout(this.sessionList);

		this.requestRender();
	}

	private async confirmRename(value: string): Promise<void> {
		const next = value.trim();
		if (!next) return;
		const target = this.renameTargetPath;
		if (!target) {
			this.exitRenameMode();
			return;
		}

		// Find current name for callback
		const renameSession = this.renameSession;
		if (!renameSession) {
			this.exitRenameMode();
			return;
		}

		try {
			await renameSession(target, next);
			await this.refreshSessionsAfterMutation();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.header.setStatusMessage({ type: "error", message: `Rename failed: ${message}` }, 5000);
		} finally {
			this.exitRenameMode();
		}
	}

	private async loadScope(scope: SessionScope, reason: "initial" | "refresh" | "toggle"): Promise<void> {
		const showCwd = scope === "all";

		// Mark loading
		if (scope === "current") {
			this.currentLoading = true;
		} else {
			this.allLoading = true;
		}

		const seq = scope === "all" ? ++this.allLoadSeq : ++this.currentLoadSeq;
		const isStaleSeq = () => (scope === "all" ? seq !== this.allLoadSeq : seq !== this.currentLoadSeq);
		this.header.setScope(scope);
		this.header.setLoading(true);
		this.sessionList.setLoading(true);
		this.requestRender();

		const onProgress = (loaded: number, total: number) => {
			if (scope !== this.scope) return;
			if (isStaleSeq()) return;
			this.header.setProgress(loaded, total);
			this.requestRender();
		};

		const clearLoadingFlags = () => {
			if (scope === "current") {
				this.currentLoading = false;
			} else {
				this.allLoading = false;
			}
		};

		try {
			const label = scope === "current" ? "Session list (current folder)" : "Session list (all)";
			const sessions = await withSessionListTimeout(
				scope === "current" ? this.currentSessionsLoader(onProgress) : this.allSessionsLoader(onProgress),
				label,
			);

			// A newer load for the same scope superseded this one: bail before
			// touching shared state so the stale result can't overwrite it
			// (last-writer-wins on out-of-order completion).
			if (isStaleSeq()) return;

			if (scope === "current") {
				this.currentSessions = sessions;
			} else {
				this.allSessions = sessions;
			}

			clearLoadingFlags();

			if (scope !== this.scope) return;

			this.header.setLoading(false);
			this.sessionList.setLoading(false);
			this.sessionList.setSessions(sessions, showCwd);
			this.requestRender();

			if (scope === "all" && sessions.length === 0 && (this.currentSessions?.length ?? 0) === 0) {
				this.onCancel();
			}
		} catch (err) {
			// A newer load superseded this one: leave the loading flag and shared
			// state to the newer load instead of clobbering them.
			if (isStaleSeq()) return;

			clearLoadingFlags();

			if (scope !== this.scope) return;

			const message = err instanceof Error ? err.message : String(err);
			this.header.setLoading(false);
			this.sessionList.setLoading(false);
			this.header.setStatusMessage({ type: "error", message: `Failed to load sessions: ${message}` }, 4000);

			if (reason === "initial") {
				this.sessionList.setSessions([], showCwd);
			}
			this.requestRender();
		}
	}

	private toggleSortMode(): void {
		// Cycle: threaded -> recent -> relevance -> threaded
		this.sortMode = this.sortMode === "threaded" ? "recent" : this.sortMode === "recent" ? "relevance" : "threaded";
		this.header.setSortMode(this.sortMode);
		this.sessionList.setSortMode(this.sortMode);
		this.requestRender();
	}

	private toggleNameFilter(): void {
		this.nameFilter = this.nameFilter === "all" ? "named" : "all";
		this.header.setNameFilter(this.nameFilter);
		this.sessionList.setNameFilter(this.nameFilter);
		this.requestRender();
	}

	private async refreshSessionsAfterMutation(): Promise<void> {
		await this.loadScope(this.scope, "refresh");
	}

	private toggleScope(): void {
		if (this.scope === "current") {
			this.scope = "all";
			this.header.setScope(this.scope);

			if (this.allSessions !== null) {
				this.header.setLoading(false);
				this.sessionList.setLoading(false);
				this.sessionList.setSessions(this.allSessions, true);
				this.requestRender();
				return;
			}

			if (!this.allLoading) {
				void this.loadScope("all", "toggle");
			}
			return;
		}

		this.scope = "current";
		this.header.setScope(this.scope);
		this.header.setLoading(this.currentLoading);
		this.sessionList.setLoading(this.currentLoading);
		this.sessionList.setSessions(this.currentSessions ?? [], false);
		this.requestRender();
	}

	getSessionList(): SessionList {
		return this.sessionList;
	}
}
