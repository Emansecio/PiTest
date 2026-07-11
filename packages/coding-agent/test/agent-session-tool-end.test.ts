import { describe, expect, it } from "vitest";
import {
	armVerificationGate,
	isMutatingToolCall,
	type VerificationGateState,
} from "../src/core/agent-session-tool-end.ts";

function freshState(): VerificationGateState {
	return {
		turnTouchedFiles: false,
		turnTouchedFilePaths: new Set(),
		turnTouchedVisual: false,
	};
}

describe("isMutatingToolCall", () => {
	it.each([
		["write", { path: "a.ts", content: "x" }, true],
		["edit", { path: "a.ts", oldText: "a", newText: "b" }, true],
		["read", { path: "a.ts" }, false],
		["bash", { command: "npm test" }, true],
		["bash", { command: "echo hello" }, false],
		["bash", { command: "ls -la" }, false],
		["grep", { pattern: "foo" }, false],
	] as const)("%s → %s", (tool, args, expected) => {
		expect(isMutatingToolCall(tool, args)).toBe(expected);
	});
});

describe("armVerificationGate", () => {
	it("sets turnTouchedFiles + path on write", () => {
		const state = freshState();
		armVerificationGate(state, "write", { path: "src/a.ts", content: "x" });
		expect(state.turnTouchedFiles).toBe(true);
		expect(state.turnTouchedFilePaths.has("src/a.ts")).toBe(true);
		expect(state.turnTouchedVisual).toBe(false);
	});

	it("marks visual extensions and lastVisualFile", () => {
		const state = freshState();
		armVerificationGate(state, "write", { path: "App.tsx", content: "x" });
		expect(state.turnTouchedVisual).toBe(true);
		expect(state.lastVisualFile).toBe("App.tsx");
	});

	it("records turnFixSite from result.details.firstChangedLine", () => {
		const state = freshState();
		armVerificationGate(
			state,
			"edit",
			{ path: "a.ts", oldText: "a", newText: "b" },
			{
				result: { details: { firstChangedLine: 12 } },
			},
		);
		expect(state.turnFixSite).toEqual({ file: "a.ts", line: 12 });
	});

	it("ignores read file ops", () => {
		const state = freshState();
		armVerificationGate(state, "read", { path: "a.ts" });
		expect(state.turnTouchedFiles).toBe(false);
		expect(state.turnTouchedFilePaths.size).toBe(0);
	});

	it("arms on mutating bash without file op", () => {
		const state = freshState();
		armVerificationGate(state, "bash", { command: "npm test" });
		expect(state.turnTouchedFiles).toBe(true);
		expect(state.turnTouchedFilePaths.size).toBe(0);
	});

	it("trackPaths:false only flips turnTouchedFiles", () => {
		const state = freshState();
		armVerificationGate(state, "write", { path: "a.ts", content: "x" }, { trackPaths: false });
		expect(state.turnTouchedFiles).toBe(true);
		expect(state.turnTouchedFilePaths.size).toBe(0);
		expect(state.turnTouchedVisual).toBe(false);
	});
});
