/**
 * Interactive `/mcp` panel — the TUI surface for managing MCP servers, opened
 * via `ctx.ui.custom`. Lists every configured server with its live connection
 * state and lets the user reconnect, enable, or disable each one, with the row
 * refreshing in real time as the manager emits state changes.
 *
 * The component is intentionally free of any `modes/interactive` imports (it
 * lives under `core/mcp`, alongside the manager it drives): it builds on raw
 * `@pit/tui` primitives and the `Theme` passed in by the host, so the built-in
 * MCP extension can construct it without a core → interactive-mode dependency.
 */

import { type Component, getKeybindings, truncateToWidth } from "@pit/tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

export type McpPanelStatus = "connected" | "disconnected" | "disabled" | "connecting";

export interface McpPanelRow {
	name: string;
	/** Endpoint URL (http/sse) or launch command (stdio). */
	target: string;
	status: McpPanelStatus;
	/** Last connection error, when disconnected. */
	error?: string;
	/** Tool names advertised by the server (empty while disconnected). */
	tools: string[];
	/** Whether this server's tools are deferred (discovered on demand) rather than eager. */
	deferred: boolean;
}

export interface McpPanelActions {
	/** Re-handshake the named server. */
	reconnect(name: string): Promise<void>;
	/** Flip enabled/disabled for the named server. */
	toggle(name: string): Promise<void>;
	/** Close the panel. */
	close(): void;
}

const STATUS_GLYPH: Record<McpPanelStatus, string> = {
	connected: "●",
	disconnected: "✗",
	disabled: "○",
	connecting: "◍",
};

const STATUS_LABEL: Record<McpPanelStatus, string> = {
	connected: "connected",
	disconnected: "disconnected",
	disabled: "disabled",
	connecting: "connecting…",
};

const STATUS_COLOR: Record<McpPanelStatus, "success" | "error" | "dim" | "warning"> = {
	connected: "success",
	disconnected: "error",
	disabled: "dim",
	connecting: "warning",
};

const MAX_VISIBLE_SERVERS = 5;

export class McpPanelComponent implements Component {
	private theme: Theme;
	private getRows: () => McpPanelRow[];
	private actions: McpPanelActions;
	private rows: McpPanelRow[];
	private selectedIndex = 0;
	private busy = new Set<string>();

	constructor(theme: Theme, getRows: () => McpPanelRow[], actions: McpPanelActions) {
		this.theme = theme;
		this.getRows = getRows;
		this.actions = actions;
		this.rows = getRows();
	}

	private hint(): string {
		const dim = (s: string) => this.theme.fg("dim", s);
		const key = (s: string) => this.theme.fg("text", s);
		return `${key("↑↓")} ${dim("move")} · ${key("r")} ${dim("reconnect")} · ${key("space")} ${dim("toggle")} · ${key("esc")} ${dim("close")}`;
	}

	/**
	 * Mark/unmark a server as actively (re)connecting so its row shows
	 * "connecting…" instead of its last settled status. Driven by the host while a
	 * background connect is in flight (the panel opens immediately and these rows
	 * flip to their real status via `refresh()` as `onStateChange` fires).
	 */
	setBusy(name: string, busy: boolean): void {
		if (busy) this.busy.add(name);
		else this.busy.delete(name);
	}

	/** Re-read live state and redraw. Safe to call from the host on every state change. */
	refresh(): void {
		this.rows = this.getRows();
		if (this.selectedIndex >= this.rows.length) {
			this.selectedIndex = Math.max(0, this.rows.length - 1);
		}
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const theme = this.theme;
		const capLine = (text: string) => truncateToWidth(text, width);
		const title = `${theme.fg("accent", "▎")} ${theme.bold("MCP servers")}${theme.fg("dim", ` · ${this.rows.length}`)}`;
		const lines = [capLine(title)];

		if (this.rows.length === 0) {
			lines.push(capLine(theme.fg("dim", "  No MCP servers configured.")), capLine(this.hint()));
			return lines;
		}

		const maxStart = Math.max(0, this.rows.length - MAX_VISIBLE_SERVERS);
		const windowStart = Math.min(maxStart, Math.max(0, this.selectedIndex - Math.floor(MAX_VISIBLE_SERVERS / 2)));
		const windowEnd = Math.min(this.rows.length, windowStart + MAX_VISIBLE_SERVERS);
		if (windowStart > 0) lines.push(capLine(theme.fg("dim", `  ↑ ${windowStart} more`)));

		this.rows.slice(windowStart, windowEnd).forEach((row, offset) => {
			const i = windowStart + offset;
			const selected = i === this.selectedIndex;
			const isBusy = this.busy.has(row.name);
			const status: McpPanelStatus = isBusy ? "connecting" : row.status;
			const glyph = theme.fg(STATUS_COLOR[status], STATUS_GLYPH[status]);
			const marker = selected ? theme.fg("accent", "▎ ") : "  ";
			const name = selected ? theme.fg("accent", theme.bold(row.name)) : theme.fg("text", row.name);
			const statusLabel = theme.fg(STATUS_COLOR[status], STATUS_LABEL[status]);
			lines.push(capLine(`${marker}${glyph} ${name}  ${statusLabel}  ${theme.fg("dim", row.target)}`));
			if (selected && row.error && status === "disconnected") {
				lines.push(capLine(`  ${theme.fg("error", `↳ ${row.error}`)}`));
			}
			if (selected && row.tools.length > 0) {
				const deferredSuffix = row.deferred ? " · on demand" : "";
				lines.push(capLine(theme.fg("dim", `  tools: ${row.tools.join(", ")}${deferredSuffix}`)));
			}
		});
		if (windowEnd < this.rows.length) {
			lines.push(capLine(theme.fg("dim", `  ↓ ${this.rows.length - windowEnd} more`)));
		}

		lines.push(capLine(this.hint()));
		return lines;
	}

	invalidate(): void {
		// Rendering is derived directly from live rows and the current width.
	}

	private selectedRow(): McpPanelRow | undefined {
		return this.rows[this.selectedIndex];
	}

	private runAction(action: (name: string) => Promise<void>): void {
		const row = this.selectedRow();
		if (!row || this.busy.has(row.name)) return;
		const name = row.name;
		this.busy.add(name);
		void action(name).finally(() => {
			this.busy.delete(name);
			// State may have changed (tools registered, connection result) — re-read.
			this.refresh();
		});
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.max(0, Math.min(this.rows.length - 1, this.selectedIndex + 1));
		} else if (keyData === "r") {
			this.runAction((name) => this.actions.reconnect(name));
		} else if (keyData === "d" || keyData === " ") {
			this.runAction((name) => this.actions.toggle(name));
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.actions.close();
		}
	}
}
