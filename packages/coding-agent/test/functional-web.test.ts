import { describe, expect, it, vi } from "vitest";
import type { ChromeDevtoolsManager } from "../src/core/chrome/chrome-devtools-manager.js";
import {
	functionalWebFixPrompt,
	isFunctionalWebDisabled,
	runFunctionalWebCheck,
} from "../src/core/verification/functional-web.js";

function mockMgr(overrides: Partial<ChromeDevtoolsManager> = {}): ChromeDevtoolsManager {
	const base = {
		navigate: vi.fn(async () => ({ created: true, target: { id: "t1", url: "http://127.0.0.1:9/" } })),
		evaluate: vi.fn(async (expr: string) => {
			if (expr === "document.readyState") return { value: "complete" };
			if (expr === "location.href") return { value: "http://127.0.0.1:9/" };
			if (expr.includes("out.push")) {
				return {
					value: [
						{ role: "button", name: "Get started", selector: "button", kind: "click" },
						{ role: "textbox", name: "Email", selector: "#email", kind: "fill" },
					],
				};
			}
			return { value: undefined };
		}),
		screenshot: vi.fn(async () => "base64"),
		a11ySnapshot: vi.fn(
			async () => `main\n  heading "Welcome"\n  button "Get started"\n  link "Docs"\n  textbox "Email"`,
		),
		getPageText: vi.fn(async () => "Welcome"),
		click: vi.fn(async () => {}),
		fill: vi.fn(async () => {}),
		closePage: vi.fn(async () => ({ closedId: "t1" })),
		readConsole: vi.fn(() => []),
		readNetwork: vi.fn(() => []),
		...overrides,
	};
	return base as unknown as ChromeDevtoolsManager;
}

describe("functional-web", () => {
	it("isFunctionalWebDisabled respects PIT_NO_FUNCTIONAL_WEB", () => {
		expect(isFunctionalWebDisabled({} as NodeJS.ProcessEnv)).toBe(false);
		expect(isFunctionalWebDisabled({ PIT_NO_FUNCTIONAL_WEB: "1" } as NodeJS.ProcessEnv)).toBe(true);
	});

	it("skips when kill-switch is set", async () => {
		vi.stubEnv("PIT_NO_FUNCTIONAL_WEB", "1");
		const result = await runFunctionalWebCheck({
			cwd: "/tmp",
			mgr: mockMgr(),
			touchedVisual: true,
			lastVisualFile: "/tmp/a.html",
		});
		expect(result.status).toBe("skipped");
		expect(result.reason).toBe("kill_switch");
		vi.unstubAllEnvs();
	});

	it("skips when Chrome manager is missing", async () => {
		const result = await runFunctionalWebCheck({
			cwd: "/tmp",
			mgr: undefined,
			touchedVisual: true,
			lastVisualFile: "/tmp/a.html",
		});
		expect(result.status).toBe("skipped");
		expect(result.reason).toBe("chrome_unavailable");
	});

	it("skips when not a web project and no visual touch", async () => {
		const result = await runFunctionalWebCheck({
			cwd: "/tmp/empty-nonexistent-dir-xyz",
			mgr: mockMgr(),
			touchedVisual: false,
		});
		expect(result.status).toBe("skipped");
		expect(result.reason).toBe("not_web");
	});

	it("passes a healthy page with interactions", async () => {
		const mgr = mockMgr();
		let textCalls = 0;
		(mgr.getPageText as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			textCalls++;
			return textCalls === 1 ? "Welcome" : "Welcome — clicked";
		});
		const result = await runFunctionalWebCheck({
			cwd: "/tmp",
			mgr,
			touchedVisual: true,
			lastVisualFile: "/tmp/a.html",
			resolveUrl: async () => ({ url: "http://127.0.0.1:9/", label: "test" }),
		});
		expect(result.status).toBe("passed");
		expect(result.interactionsAttempted).toBeGreaterThan(0);
		expect(mgr.click).toHaveBeenCalled();
		expect(mgr.fill).toHaveBeenCalled();
		expect(mgr.closePage).toHaveBeenCalled();
	});

	it("fails on console errors", async () => {
		const mgr = mockMgr({
			readConsole: vi.fn(() => [{ level: "error", text: "Uncaught boom" }]) as any,
		});
		const result = await runFunctionalWebCheck({
			cwd: "/tmp",
			mgr,
			touchedVisual: true,
			resolveUrl: async () => ({ url: "http://127.0.0.1:9/", label: "test" }),
		});
		expect(result.status).toBe("failed");
		expect(result.findings.some((f) => f.phase === "console")).toBe(true);
	});

	it("fails when click throws", async () => {
		const mgr = mockMgr({
			click: vi.fn(async () => {
				throw new Error("element not found");
			}),
		});
		const result = await runFunctionalWebCheck({
			cwd: "/tmp",
			mgr,
			touchedVisual: true,
			resolveUrl: async () => ({ url: "http://127.0.0.1:9/", label: "test" }),
		});
		expect(result.status).toBe("failed");
		expect(result.findings.some((f) => f.phase === "click")).toBe(true);
	});

	it("fails on empty a11y structure", async () => {
		const mgr = mockMgr({
			a11ySnapshot: vi.fn(async () => "(empty accessibility tree)"),
			evaluate: vi.fn(async (expr: string) => {
				if (expr === "document.readyState") return { value: "complete" };
				if (expr === "location.href") return { value: "http://127.0.0.1:9/" };
				if (expr.includes("out.push")) return { value: [] };
				return { value: undefined };
			}),
		});
		const result = await runFunctionalWebCheck({
			cwd: "/tmp",
			mgr,
			touchedVisual: true,
			resolveUrl: async () => ({ url: "http://127.0.0.1:9/", label: "test" }),
		});
		expect(result.status).toBe("failed");
		expect(result.findings.some((f) => f.phase === "a11y")).toBe(true);
	});

	it("fails when navigate throws (unexpected CDP/Chrome failure)", async () => {
		const mgr = mockMgr({
			navigate: vi.fn(async () => {
				throw new Error("CDP connection lost");
			}),
		});
		const result = await runFunctionalWebCheck({
			cwd: "/tmp",
			mgr,
			touchedVisual: true,
			resolveUrl: async () => ({ url: "http://127.0.0.1:9/", label: "test" }),
		});
		expect(result.status).toBe("failed");
		expect(result.reason).toBe("error");
		expect(result.findings.some((f) => f.phase === "error")).toBe(true);
	});

	it("functionalWebFixPrompt lists findings", () => {
		const text = functionalWebFixPrompt({
			status: "failed",
			url: "http://127.0.0.1:9/",
			findings: [{ phase: "console", message: "boom" }],
		});
		expect(text).toContain("http://127.0.0.1:9/");
		expect(text).toContain("[console] boom");
		expect(text).toContain("don't report the work done");
	});
});
