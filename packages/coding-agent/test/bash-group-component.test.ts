import { resetCapabilitiesCache, setCapabilities } from "@pit/tui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

	it("caps auto-shown error bodies", () => {
		const bodyLines = Array.from({ length: 20 }, (_, i) => `err ${i + 1}`);
		const g = new BashGroupComponent(fakeTui());
		g.addCall(bashStub("false", "error", () => bodyLines));
		const out = g.render(120).map(stripAnsi);
		expect(out.length).toBe(1 + 4 + 1);
		expect(out.some((l) => l.includes("+16 more lines"))).toBe(true);
	});

	it("shows elapsed suffix on slow pending groups", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(0);
		const g = new BashGroupComponent(fakeTui());
		g.addCall(bashStub("npm test", "pending"));
		now.mockReturnValue(5000);
		expect(stripAnsi(g.render(120)[0])).toContain("· 5s");
		now.mockRestore();
	});
});
