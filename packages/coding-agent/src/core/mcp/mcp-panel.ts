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

import { Container, getKeybindings, Spacer, Text } from "@pit/tui";
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

export class McpPanelComponent extends Container {
	private theme: Theme;
	private getRows: () => McpPanelRow[];
	private actions: McpPanelActions;
	private rows: McpPanelRow[];
	private selectedIndex = 0;
	private busy = new Set<string>();
	private listContainer: Container;
	private hintText: Text;

	constructor(theme: Theme, getRows: () => McpPanelRow[], actions: McpPanelActions) {
		super();
		this.theme = theme;
		this.getRows = getRows;
		this.actions = actions;
		this.rows = getRows();

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("MCP servers")), 1, 0));
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.hintText = new Text(this.hint(), 1, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));

		this.renderList();
	}

	private hint(): string {
		const dim = (s: string) => this.theme.fg("dim", s);
		const key = (s: string) => this.theme.fg("text", s);
		return (
			`${key("↑↓")} ${dim("navigate")}   ${key("r")} ${dim("reconnect")}   ` +
			`${key("d/space")} ${dim("enable/disable")}   ${key("esc")} ${dim("close")}`
		);
	}

	/** Re-read live state and redraw. Safe to call from the host on every state change. */
	refresh(): void {
		this.rows = this.getRows();
		if (this.selectedIndex >= this.rows.length) {
			this.selectedIndex = Math.max(0, this.rows.length - 1);
		}
		this.renderList();
	}

	private renderList(): void {
		this.listContainer.clear();
		const theme = this.theme;
		if (this.rows.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("dim", "No MCP servers configured."), 1, 0));
			return;
		}
		this.rows.forEach((row, i) => {
			const selected = i === this.selectedIndex;
			const isBusy = this.busy.has(row.name);
			const status: McpPanelStatus = isBusy ? "connecting" : row.status;
			const glyph = theme.fg(STATUS_COLOR[status], STATUS_GLYPH[status]);
			const arrow = selected ? theme.fg("accent", "→ ") : "  ";
			const name = selected ? theme.fg("accent", theme.bold(row.name)) : theme.fg("text", row.name);
			const statusLabel = theme.fg(STATUS_COLOR[status], STATUS_LABEL[status]);
			this.listContainer.addChild(new Text(`${arrow}${glyph} ${name}  ${theme.fg("dim", `[${row.target}]`)}`, 1, 0));
			this.listContainer.addChild(new Text(`     ${statusLabel}`, 1, 0));
			if (row.error && status === "disconnected") {
				this.listContainer.addChild(new Text(`     ${theme.fg("error", row.error)}`, 1, 0));
			}
			if (row.tools.length > 0) {
				const deferredSuffix = row.deferred ? theme.fg("dim", " (deferred — discovered on demand)") : "";
				const toolList = theme.fg("dim", `tools: ${row.tools.join(", ")}`);
				this.listContainer.addChild(new Text(`     ${toolList}${deferredSuffix}`, 1, 0));
			}
			this.listContainer.addChild(new Spacer(1));
		});
	}

	private selectedRow(): McpPanelRow | undefined {
		return this.rows[this.selectedIndex];
	}

	private runAction(action: (name: string) => Promise<void>): void {
		const row = this.selectedRow();
		if (!row || this.busy.has(row.name)) return;
		const name = row.name;
		this.busy.add(name);
		this.renderList();
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
			this.renderList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.max(0, Math.min(this.rows.length - 1, this.selectedIndex + 1));
			this.renderList();
		} else if (keyData === "r") {
			this.runAction((name) => this.actions.reconnect(name));
		} else if (keyData === "d" || keyData === " ") {
			this.runAction((name) => this.actions.toggle(name));
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.actions.close();
		}
	}
}
