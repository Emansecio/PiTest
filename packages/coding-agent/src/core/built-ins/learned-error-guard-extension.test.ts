/**
 * Unit coverage for the preventive learned-error guard. A fake ExtensionAPI
 * captures the `tool_call` handler so we can drive synthetic calls through it
 * and assert the block decision, with a mocked aggregated-store provider.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../extensions/index.js";
import type { AggregatedLearnedError } from "../learned-error-store.ts";
import { fingerprintToolArgs } from "../tool-call-stats.ts";
import { createLearnedErrorGuardExtension } from "./learned-error-guard-extension.ts";

type ToolCallHandler = (event: unknown) => { block?: boolean; reason?: string } | undefined;

function mountExtension(options: Parameters<typeof createLearnedErrorGuardExtension>[0]) {
	let handler: ToolCallHandler | undefined;
	const pi = {
		on: (event: string, h: ToolCallHandler) => {
			if (event === "tool_call") handler = h;
		},
	} as unknown as ExtensionAPI;
	createLearnedErrorGuardExtension(options)(pi);
	return (toolName: string, input: unknown) => handler?.({ type: "tool_call", toolCallId: "t1", toolName, input });
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
	it("blocks a call whose args match a recurring, uncovered failure", () => {
		const call = mountExtension({ provider: () => [entry()] });
		const result = call("bash", BASH_ARGS);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("5×");
		expect(result?.reason).toContain("3 prior sessions");
	});

	it("fires only once per pattern, then lets the retry through", () => {
		const call = mountExtension({ provider: () => [entry()] });
		expect(call("bash", BASH_ARGS)?.block).toBe(true);
		expect(call("bash", BASH_ARGS)).toBeUndefined();
	});

	it("does not block below the occurrence threshold", () => {
		const call = mountExtension({ provider: () => [entry({ totalCount: 2 })] });
		expect(call("bash", BASH_ARGS)).toBeUndefined();
	});

	it("does not block below the session threshold", () => {
		const call = mountExtension({ provider: () => [entry({ sessionCount: 1 })] });
		expect(call("bash", BASH_ARGS)).toBeUndefined();
	});

	it("does not block a pattern already covered by a built-in rule", () => {
		const call = mountExtension({ provider: () => [entry({ matchedRuleIds: ["bash-path-mangled-backslashes"] })] });
		expect(call("bash", BASH_ARGS)).toBeUndefined();
	});

	it("does not block a different tool or different args", () => {
		const call = mountExtension({ provider: () => [entry()] });
		expect(call("read", BASH_ARGS)).toBeUndefined();
		expect(call("bash", { command: "rg bar D:/y" })).toBeUndefined();
	});

	it("is a no-op when disabled", () => {
		const call = mountExtension({ enabled: false, provider: () => [entry()] });
		expect(call("bash", BASH_ARGS)).toBeUndefined();
	});

	it("matches across path-key aliases (file_path → path)", () => {
		const canonical = { path: "/repo/a.ts" };
		const aliasArgs = { file_path: "/repo/a.ts" };
		const sample = fingerprintToolArgs(canonical, 160);
		const call = mountExtension({
			provider: () => [entry({ tool: "read", sampleArgs: sample })],
		});
		expect(call("read", aliasArgs)?.block).toBe(true);
	});
});
