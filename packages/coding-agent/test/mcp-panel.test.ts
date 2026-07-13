import { visibleWidth } from "@pit/tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { McpPanelComponent, type McpPanelRow } from "../src/core/mcp/mcp-panel.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

beforeAll(() => initTheme("dark"));

const rows: McpPanelRow[] = [
	{
		name: "burp",
		target: "C:/Program Files/Eclipse Adoptium/jdk-21/bin/java.exe --server-url http://127.0.0.1:9876",
		status: "disconnected",
		error: "Connection timed out after 10 seconds",
		tools: ["proxy_history", "send_to_repeater"],
		deferred: true,
	},
	{
		name: "filesystem",
		target: "stdio: filesystem-server",
		status: "connected",
		tools: [],
		deferred: false,
	},
];

function createPanel(inputRows: McpPanelRow[] = rows) {
	const actions = {
		reconnect: vi.fn(async () => {}),
		toggle: vi.fn(async () => {}),
		close: vi.fn(),
	};
	return { actions, panel: new McpPanelComponent(theme, () => inputRows, actions) };
}

describe("McpPanelComponent", () => {
	test("renders compact width-safe rows with an accent rail", () => {
		const { panel } = createPanel();

		for (const width of [40, 80, 140]) {
			const lines = panel.render(width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		const narrow = stripAnsi(panel.render(40).join("\n"));
		expect(narrow).toContain("▎");
		expect(narrow).toContain("burp");
		expect(narrow).toContain("disconnected");
		expect(narrow).not.toContain("127.0.0.1:9876");
	});

	test("shows details only when a row provides them", () => {
		const plain = stripAnsi(createPanel().panel.render(100).join("\n"));
		expect(plain).toContain("Connection timed out after 10 seconds");
		expect(plain).toContain("proxy_history, send_to_repeater");
		expect(plain).toContain("on demand");

		const connectedOnly = stripAnsi(createPanel([rows[1]!]).panel.render(100).join("\n"));
		expect(connectedOnly).not.toContain("timed out");
		expect(connectedOnly).not.toContain("tools:");
	});

	test("preserves reconnect, toggle and navigation actions", async () => {
		const { actions, panel } = createPanel();
		panel.handleInput("j");
		panel.handleInput("r");
		await vi.waitFor(() => expect(actions.reconnect).toHaveBeenCalledWith("filesystem"));
		panel.handleInput("d");
		await vi.waitFor(() => expect(actions.toggle).toHaveBeenCalledWith("filesystem"));
	});

	test("keeps large server lists in a navigable window", () => {
		const manyRows = Array.from(
			{ length: 8 },
			(_, index): McpPanelRow => ({
				name: `server-${index + 1}`,
				target: `stdio: server-${index + 1}`,
				status: "connected",
				tools: [],
				deferred: false,
			}),
		);
		const { panel } = createPanel(manyRows);

		const initial = stripAnsi(panel.render(80).join("\n"));
		expect(initial).toContain("server-1");
		expect(initial).not.toContain("server-8");
		for (let index = 0; index < 7; index++) panel.handleInput("j");
		const final = stripAnsi(panel.render(80).join("\n"));
		expect(final).toContain("server-8");
		expect(final).not.toContain("server-1");
		expect(final).toMatch(/↑ \d+ more/);
	});
});
