import { resetCapabilitiesCache, setCapabilities } from "@pit/tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BashGroupComponent } from "../src/modes/interactive/components/bash-group.js";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

beforeAll(() => {
	initTheme("dark");
	setCapabilities({ images: null, trueColor: false, hyperlinks: false });
});
afterAll(() => resetCapabilitiesCache());

function fakeTui() {
	return {
		requestRender() {},
		addAnimationCallback() {
			return () => {};
		},
	} as any;
}

function bashStub(
	command: string,
	state: "pending" | "success" | "error" = "success",
	render: () => string[] = () => [`body: ${command}`],
): ToolExecutionComponent {
	return {
		setActivityChild() {},
		setExpanded() {},
		setResultExpanded() {},
		getActivityState: () => state,
		isAborted: () => false,
		getToolName: () => "bash",
		getArgs: () => ({ command }),
		getResultDetails: () => undefined,
		render,
	} as unknown as ToolExecutionComponent;
}

describe("BashGroupComponent", () => {
	it("shows a single shortened command", () => {
		const g = new BashGroupComponent(fakeTui());
		g.addCall(bashStub('echo "=== status ===" && git status --short'));
		const head = g.render(120).map(stripAnsi)[0];
		expect(head).toContain("Ran");
		expect(head).toContain("git status --short");
		expect(head).not.toContain("===");
		expect(head).not.toContain("to expand");
	});

	it("collapses multiple commands into a counter", () => {
		const g = new BashGroupComponent(fakeTui());
		g.addCall(bashStub("git status"));
		g.addCall(bashStub("grep foo ."));
		g.addCall(bashStub("npm test"));
		const head = g.render(120).map(stripAnsi)[0];
		expect(head).toContain("Ran");
		expect(head).toContain("3 commands");
		expect(head).not.toContain("git status");
	});

	it("renders collapsed errors header-only (no auto-shown body)", () => {
		const bodyLines = Array.from({ length: 20 }, (_, i) => `err ${i + 1}`);
		const g = new BashGroupComponent(fakeTui());
		g.addCall(bashStub("false", "error", () => bodyLines));
		const out = g.render(120).map(stripAnsi);
		expect(out.length).toBe(1);
		expect(out[0]).toContain("Ran");
		expect(out.some((l) => l.includes("err 1"))).toBe(false);
	});

	it("explicit expansion still renders the full error body", () => {
		const bodyLines = Array.from({ length: 20 }, (_, i) => `err ${i + 1}`);
		const g = new BashGroupComponent(fakeTui());
		g.addCall(bashStub("false", "error", () => bodyLines));
		g.setExpanded(true);
		const out = g.render(120).map(stripAnsi);
		expect(out.some((l) => l.includes("err 1"))).toBe(true);
		expect(out.some((l) => l.includes("err 20"))).toBe(true);
	});

	it("leaves transient elapsed telemetry to the working loader", () => {
		const g = new BashGroupComponent(fakeTui());
		g.addCall(bashStub("npm test", "pending"));
		expect(stripAnsi(g.render(120)[0])).not.toMatch(/· \d+s/);
	});
});
