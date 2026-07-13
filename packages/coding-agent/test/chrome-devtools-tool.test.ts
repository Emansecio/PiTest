import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeDevtoolsManager, setCurrentChromeDevtoolsManager } from "../src/core/chrome/chrome-devtools-manager.js";
import {
	createChromeClosePageDefinition,
	createChromeEvaluateDefinition,
	createChromeListPagesDefinition,
	createChromeNavigateDefinition,
	createChromeReadNetworkDefinition,
	createChromeScreenshotDefinition,
} from "../src/core/tools/chrome-devtools.js";

afterEach(() => setCurrentChromeDevtoolsManager(undefined));

// ToolDefinition.execute takes (toolCallId, params, signal, onUpdate, ctx).
function runExec(def: { execute: (...args: any[]) => any }, input: unknown) {
	return def.execute("call", input, undefined, undefined, undefined);
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("");
}

/** Build a manager whose CDP layer is fully mocked. */
function mockManager(over?: Partial<Record<string, any>>) {
	const mgr = new ChromeDevtoolsManager({
		host: "h",
		port: 9222,
		list: async () => [],
		create: async () => ({}) as any,
	});
	return Object.assign(mgr, over) as ChromeDevtoolsManager;
}

describe("chrome_devtools tools", () => {
	it("fail gracefully when no manager is bound", async () => {
		setCurrentChromeDevtoolsManager(undefined);
		const def = createChromeListPagesDefinition();
		const res = await runExec(def, {});
		expect(res.details.ok).toBe(false);
		expect(text(res)).toMatch(/unavailable/i);
	});

	it("list_pages renders the page list", async () => {
		const mgr = mockManager({
			listPages: vi.fn().mockResolvedValue([{ id: "p1", title: "Example", url: "http://a", type: "page" }]),
		});
		setCurrentChromeDevtoolsManager(mgr);
		const res = await runExec(createChromeListPagesDefinition(), {});
		expect(res.details.ok).toBe(true);
		expect(text(res)).toContain("p1");
		expect(text(res)).toContain("Example");
	});

	it("navigate reports a new tab", async () => {
		const mgr = mockManager({
			navigate: vi.fn().mockResolvedValue({ created: true, target: { id: "n1", url: "http://x" } }),
		});
		setCurrentChromeDevtoolsManager(mgr);
		const res = await runExec(createChromeNavigateDefinition(), { url: "http://x", newTab: true });
		expect(text(res)).toContain("Opened new tab");
		expect(text(res)).toContain("http://x");
	});

	it("close_page closes the page and reports a clean state", async () => {
		const closePage = vi.fn().mockResolvedValue({ closedId: "n1" });
		const mgr = mockManager({ closePage });
		setCurrentChromeDevtoolsManager(mgr);
		const res = await runExec(createChromeClosePageDefinition(), {});
		expect(closePage).toHaveBeenCalledWith(undefined, undefined);
		expect(res.details.ok).toBe(true);
		expect(text(res)).toContain("Closed page n1");
		expect(text(res)).toContain("no page selected");
	});

	it("close_page forwards an explicit id", async () => {
		const closePage = vi.fn().mockResolvedValue({ closedId: "abc" });
		const mgr = mockManager({ closePage });
		setCurrentChromeDevtoolsManager(mgr);
		await runExec(createChromeClosePageDefinition(), { id: "abc" });
		expect(closePage).toHaveBeenCalledWith("abc", undefined);
	});

	it("evaluate returns the JSON value", async () => {
		const mgr = mockManager({ evaluate: vi.fn().mockResolvedValue({ value: "Example Domain" }) });
		setCurrentChromeDevtoolsManager(mgr);
		const res = await runExec(createChromeEvaluateDefinition(), { expression: "document.title" });
		expect(text(res)).toContain("Example Domain");
	});

	it("screenshot returns an image content block", async () => {
		const mgr = mockManager({ screenshot: vi.fn().mockResolvedValue("BASE64PNG") });
		setCurrentChromeDevtoolsManager(mgr);
		const res = await runExec(createChromeScreenshotDefinition(), { fullPage: true });
		const image = res.content.find((c: any) => c.type === "image");
		expect(image).toMatchObject({ type: "image", data: "BASE64PNG", mimeType: "image/png" });
	});

	it("read_network returns full bounded detail for a captured hop", async () => {
		const getNetworkEntry = vi.fn().mockReturnValue({
			entryId: "r1#1",
			requestId: "r1",
			hop: 1,
			method: "POST",
			url: "https://a.test/api?token=[REDACTED:http-url]",
			requestHeaders: { Authorization: "[REDACTED:http-header]" },
			requestBody: '{"token":"[REDACTED:generic]"}',
			responseBody: '{"ok":true}',
			status: 200,
		});
		const mgr = mockManager({ getNetworkEntry });
		setCurrentChromeDevtoolsManager(mgr);
		const res = await runExec(createChromeReadNetworkDefinition(), {
			requestId: "r1",
			hop: 1,
			includeResponseBody: false,
		});

		expect(getNetworkEntry).toHaveBeenCalledWith("r1", 1);
		expect(text(res)).toContain('"entryId": "r1#1"');
		expect(text(res)).toContain('"requestBody"');
		expect(text(res)).not.toContain('"responseBody"');
	});

	it("surfaces manager errors as a failed result", async () => {
		const mgr = mockManager({ evaluate: vi.fn().mockRejectedValue(new Error("No page selected.")) });
		setCurrentChromeDevtoolsManager(mgr);
		const res = await runExec(createChromeEvaluateDefinition(), { expression: "1" });
		expect(res.details.ok).toBe(false);
		expect(text(res)).toContain("No page selected");
	});
});
