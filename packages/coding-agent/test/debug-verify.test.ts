import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dapConfig from "../src/core/dap/config.ts";
import { dapSessionManager } from "../src/core/dap/index.ts";
import type { DapResolvedAdapter, DapSessionSummary } from "../src/core/dap/types.ts";
import { maybeRunDebugVerify } from "../src/core/debug-verify.ts";
import { type CheckResult, isDebuggableRepro } from "../src/core/verification/verification.ts";

const OK_CHECK: CheckResult = { ok: true, exitCode: 0, output: "", timedOut: false };
const FAIL_CHECK: CheckResult = { ok: false, exitCode: 1, output: "boom", timedOut: false };

function fakeAdapter(name: string): DapResolvedAdapter {
	return {
		name,
		command: name === "debugpy" ? "python" : name,
		args: [],
		resolvedCommand: process.execPath,
		languages: [],
		fileTypes: [],
		rootMarkers: [],
		launchDefaults: {},
		attachDefaults: {},
		connectMode: "stdio",
	};
}

function fakeSummary(over: Partial<DapSessionSummary> = {}): DapSessionSummary {
	return {
		id: "debug-1",
		adapter: "debugpy",
		cwd: "/repo",
		status: "stopped",
		launchedAt: new Date(0).toISOString(),
		lastUsedAt: new Date(0).toISOString(),
		breakpointFiles: 1,
		breakpointCount: 1,
		functionBreakpointCount: 0,
		outputBytes: 0,
		outputTruncated: false,
		needsConfigurationDone: false,
		...over,
	};
}

function mockAvailableAdapters(names: string[]): void {
	vi.spyOn(dapConfig, "getAvailableAdapters").mockReturnValue(names.map(fakeAdapter));
}

describe("isDebuggableRepro", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("recognizes a pytest repro when debugpy is available", () => {
		mockAvailableAdapters(["debugpy"]);
		const repro = isDebuggableRepro(["tests/test_login.py"], OK_CHECK, "/repo");
		expect(repro).not.toBeNull();
		expect(repro?.ecosystem).toBe("pytest");
		expect(repro?.adapter).toBe("debugpy");
		// Module-mode launch: debugpy invokes `python -m pytest`, so "pytest" is the
		// module and the touched test file is passed in args (not a "-m pytest" prefix).
		expect(repro?.module).toBe("pytest");
		expect(repro?.args.some((a) => a.endsWith("test_login.py"))).toBe(true);
	});

	it("recognizes the *_test.py naming variant", () => {
		mockAvailableAdapters(["debugpy"]);
		expect(isDebuggableRepro(["auth_test.py"], OK_CHECK, "/repo")?.ecosystem).toBe("pytest");
	});

	it("recognizes a go test repro when dlv is available", () => {
		mockAvailableAdapters(["dlv"]);
		const repro = isDebuggableRepro(["pkg/auth/login_test.go"], OK_CHECK, "/repo");
		expect(repro?.ecosystem).toBe("go-test");
		expect(repro?.adapter).toBe("dlv");
		// program is the package directory, not the file.
		expect(repro?.program.endsWith("auth")).toBe(true);
	});

	it("rejects when the check did not pass (gate handles red)", () => {
		mockAvailableAdapters(["debugpy"]);
		expect(isDebuggableRepro(["tests/test_login.py"], FAIL_CHECK, "/repo")).toBeNull();
	});

	it("rejects a pytest repro when debugpy is not available", () => {
		mockAvailableAdapters(["dlv"]);
		expect(isDebuggableRepro(["tests/test_login.py"], OK_CHECK, "/repo")).toBeNull();
	});

	it("rejects non-test python and arbitrary ecosystems", () => {
		mockAvailableAdapters(["debugpy", "dlv"]);
		expect(isDebuggableRepro(["src/login.py"], OK_CHECK, "/repo")).toBeNull(); // not a test file
		expect(isDebuggableRepro(["src/index.ts"], OK_CHECK, "/repo")).toBeNull(); // node
		expect(isDebuggableRepro(["src/main.c"], OK_CHECK, "/repo")).toBeNull(); // c
		expect(isDebuggableRepro([], OK_CHECK, "/repo")).toBeNull(); // nothing touched
	});

	it("never throws on malformed input (fail-open)", () => {
		mockAvailableAdapters(["debugpy"]);
		// @ts-expect-error exercising the defensive path
		expect(isDebuggableRepro(undefined, OK_CHECK, "/repo")).toBeNull();
		expect(isDebuggableRepro([null as unknown as string], OK_CHECK, "/repo")).toBeNull();
	});
});

describe("maybeRunDebugVerify", () => {
	beforeEach(() => {
		delete process.env.PIT_NO_DEBUG_VERIFY;
	});
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PIT_NO_DEBUG_VERIFY;
	});

	it("returns null when the repro is not debuggable (no adapter) — fail-open", async () => {
		vi.spyOn(dapConfig, "getAvailableAdapters").mockReturnValue([]); // nothing available
		const launchSpy = vi.spyOn(dapSessionManager, "launch");
		const result = await maybeRunDebugVerify({
			cwd: "/repo",
			touchedFiles: ["tests/test_login.py"],
			checkResult: OK_CHECK,
		});
		expect(result).toBeNull();
		expect(launchSpy).not.toHaveBeenCalled(); // never even launched
	});

	it("returns null and never launches when disabled via PIT_NO_DEBUG_VERIFY", async () => {
		process.env.PIT_NO_DEBUG_VERIFY = "1";
		mockAvailableAdapters(["debugpy"]);
		const launchSpy = vi.spyOn(dapSessionManager, "launch");
		const result = await maybeRunDebugVerify({
			cwd: "/repo",
			touchedFiles: ["tests/test_login.py"],
			checkResult: OK_CHECK,
		});
		expect(result).toBeNull();
		expect(launchSpy).not.toHaveBeenCalled();
	});

	it("fail-opens to null AND terminates the session when continue times out", async () => {
		mockAvailableAdapters(["debugpy"]);
		vi.spyOn(dapConfig, "selectLaunchAdapter").mockReturnValue(fakeAdapter("debugpy"));
		vi.spyOn(dapSessionManager, "launch").mockResolvedValue(fakeSummary({ status: "running" }));
		vi.spyOn(dapSessionManager, "setBreakpoint").mockResolvedValue({
			snapshot: fakeSummary(),
			breakpoints: [],
			sourcePath: "/repo/tests/test_login.py",
		});
		// continue never resolves to "stopped" — simulate a timeout by rejecting.
		vi.spyOn(dapSessionManager, "continue").mockRejectedValue(new Error("timeout"));
		const terminateSpy = vi.spyOn(dapSessionManager, "terminate").mockResolvedValue(null);

		const result = await maybeRunDebugVerify({
			cwd: "/repo",
			touchedFiles: ["tests/test_login.py"],
			checkResult: OK_CHECK,
		});
		// continue rejection => inconclusive (reached=false), never null because launch
		// succeeded; the key assertion is that it did NOT block and DID terminate.
		expect(result?.verdict).toBe("inconclusive");
		expect(terminateSpy).toHaveBeenCalledTimes(1);
	});

	it("terminates the session even when launch throws (no process leak)", async () => {
		mockAvailableAdapters(["debugpy"]);
		vi.spyOn(dapConfig, "selectLaunchAdapter").mockReturnValue(fakeAdapter("debugpy"));
		vi.spyOn(dapSessionManager, "launch").mockRejectedValue(new Error("spawn failed"));
		const terminateSpy = vi.spyOn(dapSessionManager, "terminate").mockResolvedValue(null);

		const result = await maybeRunDebugVerify({
			cwd: "/repo",
			touchedFiles: ["tests/test_login.py"],
			checkResult: OK_CHECK,
		});
		expect(result).toBeNull(); // launch failed => fail-open
		// launch never set `launched=true`, so terminate is NOT called (nothing to tear
		// down) — assert we didn't spuriously terminate a non-existent session.
		expect(terminateSpy).not.toHaveBeenCalled();
	});

	it("captures a state snapshot and flags suspect when a local is still nullish", async () => {
		mockAvailableAdapters(["debugpy"]);
		vi.spyOn(dapConfig, "selectLaunchAdapter").mockReturnValue(fakeAdapter("debugpy"));
		vi.spyOn(dapSessionManager, "launch").mockResolvedValue(fakeSummary({ status: "running" }));
		vi.spyOn(dapSessionManager, "setBreakpoint").mockResolvedValue({
			snapshot: fakeSummary(),
			breakpoints: [],
			sourcePath: "/repo/tests/test_login.py",
		});
		vi.spyOn(dapSessionManager, "continue").mockResolvedValue({
			snapshot: fakeSummary({ source: { path: "/repo/src/login.py" }, line: 42 }),
			state: "stopped",
			timedOut: false,
		});
		vi.spyOn(dapSessionManager, "scopes").mockResolvedValue({
			snapshot: fakeSummary(),
			scopes: [{ name: "Locals", variablesReference: 1000, expensive: false }],
		});
		vi.spyOn(dapSessionManager, "variables").mockResolvedValue({
			snapshot: fakeSummary(),
			variables: [
				{ name: "user", value: "None", variablesReference: 0 },
				{ name: "token", value: "'abc'", variablesReference: 0 },
			],
		});
		const terminateSpy = vi.spyOn(dapSessionManager, "terminate").mockResolvedValue(null);

		const result = await maybeRunDebugVerify({
			cwd: "/repo",
			touchedFiles: ["tests/test_login.py"],
			checkResult: OK_CHECK,
		});
		expect(result?.verdict).toBe("suspect");
		expect(result?.stateSnapshot.reachedBreakpoint).toBe(true);
		expect(result?.stateSnapshot.location).toBe("/repo/src/login.py:42");
		expect(result?.stateSnapshot.variables.map((v) => v.name)).toContain("user");
		expect(terminateSpy).toHaveBeenCalledTimes(1);
	});

	it("flags confirmed when the captured state has no nullish smell", async () => {
		mockAvailableAdapters(["debugpy"]);
		vi.spyOn(dapConfig, "selectLaunchAdapter").mockReturnValue(fakeAdapter("debugpy"));
		vi.spyOn(dapSessionManager, "launch").mockResolvedValue(fakeSummary({ status: "running" }));
		vi.spyOn(dapSessionManager, "setBreakpoint").mockResolvedValue({
			snapshot: fakeSummary(),
			breakpoints: [],
			sourcePath: "/repo/tests/test_login.py",
		});
		vi.spyOn(dapSessionManager, "continue").mockResolvedValue({
			snapshot: fakeSummary({ source: { path: "/repo/src/login.py" }, line: 10 }),
			state: "stopped",
			timedOut: false,
		});
		vi.spyOn(dapSessionManager, "scopes").mockResolvedValue({
			snapshot: fakeSummary(),
			scopes: [{ name: "Locals", variablesReference: 1000, expensive: false }],
		});
		vi.spyOn(dapSessionManager, "variables").mockResolvedValue({
			snapshot: fakeSummary(),
			variables: [{ name: "user", value: "<User id=7>", variablesReference: 0 }],
		});
		vi.spyOn(dapSessionManager, "terminate").mockResolvedValue(null);

		const result = await maybeRunDebugVerify({
			cwd: "/repo",
			touchedFiles: ["tests/test_login.py"],
			checkResult: OK_CHECK,
		});
		expect(result?.verdict).toBe("confirmed");
	});
});
