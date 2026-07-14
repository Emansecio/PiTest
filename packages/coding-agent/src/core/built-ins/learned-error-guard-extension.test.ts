/**
 * Unit coverage for the preventive learned-error guard. A fake ExtensionAPI
 * captures the `tool_call` handler so we can drive synthetic calls through it
 * and assert the block decision, with a mocked aggregated-store provider.
 */

import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../extensions/index.js";
import type { AggregatedLearnedError } from "../learned-error-store.ts";
import { fingerprintToolArgs } from "../tool-call-stats.ts";
import { createLearnedErrorGuardExtension } from "./learned-error-guard-extension.ts";

type ToolCallHandler = (
	event: unknown,
) => Promise<{ block?: boolean; reason?: string } | undefined> | { block?: boolean; reason?: string } | undefined;

function mountExtension(options: Parameters<typeof createLearnedErrorGuardExtension>[0]) {
	let handler: ToolCallHandler | undefined;
	const pi = {
		on: (event: string, h: ToolCallHandler) => {
			if (event === "tool_call") handler = h;
		},
	} as unknown as ExtensionAPI;
	createLearnedErrorGuardExtension(options)(pi);
	return async (toolName: string, input: unknown) =>
		await handler?.({ type: "tool_call", toolCallId: "t1", toolName, input });
}

const BASH_ARGS = { command: "rg foo C:/x" };
const SAMPLE_ARGS = fingerprintToolArgs(BASH_ARGS, 160);

function entry(overrides: Partial<AggregatedLearnedError> = {}): AggregatedLearnedError {
	return {
		tool: "bash",
		fingerprint: "rg: C:/x: No such file or directory N",
		totalCount: 5,
		sessionCount: 3,
		matchedRuleIds: [],
		sampleErrorText: "rg: C:/x: No such file or directory",
		sampleArgs: SAMPLE_ARGS,
		...overrides,
	};
}

describe("createLearnedErrorGuardExtension", () => {
	it("blocks a call whose args match a recurring, uncovered failure", async () => {
		const call = mountExtension({ provider: () => [entry()] });
		const result = await call("bash", BASH_ARGS);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("5×");
		expect(result?.reason).toContain("3 prior sessions");
	});

	it("fires only once per pattern, then lets the retry through", async () => {
		const call = mountExtension({ provider: () => [entry()] });
		expect((await call("bash", BASH_ARGS))?.block).toBe(true);
		expect(await call("bash", BASH_ARGS)).toBeUndefined();
	});

	it("records blocked then overridden diagnostics tagged with the known-failed-call ruleId", async () => {
		resetRuntimeDiagnostics();
		const call = mountExtension({ provider: () => [entry()] });
		expect((await call("bash", BASH_ARGS))?.block).toBe(true);
		expect(await call("bash", BASH_ARGS)).toBeUndefined(); // fire-once escape -> override
		const events = getRuntimeDiagnostics().recent.filter((e) => e.category === "guard.learned-error");
		expect(events.map((e) => e.context?.outcome)).toEqual(["blocked", "overridden"]);
		expect(events.every((e) => e.context?.ruleId === "known-failed-call")).toBe(true);
	});

	it("does not block below the occurrence threshold", async () => {
		const call = mountExtension({ provider: () => [entry({ totalCount: 2 })] });
		expect(await call("bash", BASH_ARGS)).toBeUndefined();
	});

	it("does not block below the session threshold (and below count-dominant)", async () => {
		// totalCount 3 clears minOccurrences but not the count-dominant bar (5), and a
		// single session fails the cross-session bar — so no guard fires.
		const call = mountExtension({ provider: () => [entry({ totalCount: 3, sessionCount: 1 })] });
		expect(await call("bash", BASH_ARGS)).toBeUndefined();
	});

	it("blocks a count-dominant single-session pattern (totalCount >= 5)", async () => {
		const call = mountExtension({ provider: () => [entry({ totalCount: 5, sessionCount: 1 })] });
		expect((await call("bash", BASH_ARGS))?.block).toBe(true);
	});

	it("does not block a pattern already covered by a built-in rule", async () => {
		const call = mountExtension({ provider: () => [entry({ matchedRuleIds: ["bash-path-mangled-backslashes"] })] });
		expect(await call("bash", BASH_ARGS)).toBeUndefined();
	});

	it("does not block a different tool or different args", async () => {
		const call = mountExtension({ provider: () => [entry()] });
		expect(await call("read", BASH_ARGS)).toBeUndefined();
		expect(await call("bash", { command: "rg bar D:/y" })).toBeUndefined();
	});

	it("is a no-op when disabled", async () => {
		const call = mountExtension({ enabled: false, provider: () => [entry()] });
		expect(await call("bash", BASH_ARGS)).toBeUndefined();
	});

	it("matches across path-key aliases (file_path → path)", async () => {
		const canonical = { path: "/repo/a.ts" };
		const aliasArgs = { file_path: "/repo/a.ts" };
		const sample = fingerprintToolArgs(canonical, 160);
		const call = mountExtension({
			provider: () => [entry({ tool: "read", sampleArgs: sample })],
		});
		expect((await call("read", aliasArgs))?.block).toBe(true);
	});

	it("matches a whitespace-variant of the stored failure", async () => {
		const stored = fingerprintToolArgs({ command: "rg foo bar" }, 160);
		const call = mountExtension({
			provider: () => [entry({ tool: "bash", sampleArgs: stored })],
		});
		// Extra runs of whitespace between the same tokens — formatting only.
		expect((await call("bash", { command: "rg   foo    bar" }))?.block).toBe(true);
	});

	it("matches a path-separator / drive-case variant of the stored failure", async () => {
		const stored = fingerprintToolArgs({ path: "C:\\repo\\a.ts" }, 160);
		const call = mountExtension({
			provider: () => [entry({ tool: "read", sampleArgs: stored })],
		});
		// Forward slashes + lowercase drive letter for the same file.
		expect((await call("read", { path: "c:/repo/a.ts" }))?.block).toBe(true);
	});

	it("does NOT match a genuinely different path (no false positive)", async () => {
		const stored = fingerprintToolArgs({ path: "C:\\repo\\a.ts" }, 160);
		const call = mountExtension({
			provider: () => [entry({ tool: "read", sampleArgs: stored })],
		});
		// Same folder, different file — content differs, not just formatting.
		expect(await call("read", { path: "c:/repo/b.ts" })).toBeUndefined();
	});

	it("does NOT fold away non-formatting whitespace (x = 1 vs x=1 stay distinct)", async () => {
		const stored = fingerprintToolArgs({ oldText: "const x = 1" }, 160);
		const call = mountExtension({
			provider: () => [entry({ tool: "edit", sampleArgs: stored })],
		});
		expect(await call("edit", { oldText: "const x=1" })).toBeUndefined();
	});

	it("still matches a legacy exact fingerprint byte-for-byte", async () => {
		// A fingerprint written before normalisation existed — raw backslashes and
		// uppercase drive letter. An identical live call must still fire via the
		// exact-match path (backward compatibility).
		const legacy = fingerprintToolArgs({ command: "type C:\\Temp\\LOG.txt" }, 160);
		const call = mountExtension({
			provider: () => [entry({ tool: "bash", sampleArgs: legacy })],
		});
		expect((await call("bash", { command: "type C:\\Temp\\LOG.txt" }))?.block).toBe(true);
	});
});
