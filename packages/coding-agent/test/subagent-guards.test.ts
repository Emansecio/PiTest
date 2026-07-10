import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	bundleGroundingGuardFactories,
	subagentGroundingGuardFactories,
} from "../src/core/built-ins/grounding-guard-registry.ts";
import { areSubagentGuardsDisabled, createSubagentGuardChain } from "../src/core/built-ins/subagent-guards.ts";
import type { ToolCallEvent } from "../src/core/extensions/types.ts";

/**
 * The subagent guard chain re-runs the parent's grounding guards (read-guard,
 * edit-precondition, path/import/symbol/pattern/bash grounding) so a spawned
 * subagent gets the same pre-exec protection the main agent has. These assert
 * parity for the two most load-bearing guards plus the opt-out.
 */
describe("subagent guard chain", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pit-subguard-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const call = (toolName: string, input: Record<string, unknown>, id = "t"): ToolCallEvent =>
		({ type: "tool_call", toolName, toolCallId: id, input }) as ToolCallEvent;

	it("blocks writing a file the subagent never read (read-guard parity)", async () => {
		const file = join(dir, "config.json");
		writeFileSync(file, '{"a":1}\n');
		const chain = createSubagentGuardChain({ cwd: dir });

		const decision = await chain.beforeToolCall(call("write", { path: file, content: "{}" }, "w"));
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toMatch(/has not been read/i);
	});

	it("allows the write once the file is read in the same chain", async () => {
		const file = join(dir, "config.json");
		writeFileSync(file, '{"a":1}\n');
		const chain = createSubagentGuardChain({ cwd: dir });

		await chain.beforeToolCall(call("read", { path: file }, "r"));
		const decision = await chain.beforeToolCall(call("write", { path: file, content: '{"a":2}\n' }, "w"));
		expect(decision).toBeUndefined();
	});

	it("blocks a read of a near-miss path with the close sibling (path-grounding parity)", async () => {
		writeFileSync(join(dir, "config.json"), "{}");
		const chain = createSubagentGuardChain({ cwd: dir });

		const decision = await chain.beforeToolCall(call("read", { path: join(dir, "config.jsno") }, "1"));
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toMatch(/config\.json/);
	});

	it("blocks a middle-tier destructive bash once, then allows identical re-issue", async () => {
		const chain = createSubagentGuardChain({ cwd: dir });
		const first = await chain.beforeToolCall(call("bash", { command: "rm -rf ./src" }, "d1"));
		expect(first?.block).toBe(true);
		expect(first?.reason).toMatch(/re-issue/i);
		const second = await chain.beforeToolCall(call("bash", { command: "rm -rf ./src" }, "d1"));
		expect(second).toBeUndefined();
	});

	it("does not speed-bump catastrophic rm -rf / (deny-floor owns that tier)", async () => {
		const chain = createSubagentGuardChain({ cwd: dir });
		const decision = await chain.beforeToolCall(call("bash", { command: "rm -rf /" }, "cat"));
		expect(decision).toBeUndefined();
	});

	it("blocks a call matching a recurring learned-error fingerprint (parity with parent)", async () => {
		const { fingerprintToolArgs } = await import("../src/core/tool-call-stats.ts");
		const bashArgs = { command: "rg foo C:/x" };
		const sampleArgs = fingerprintToolArgs(bashArgs, 160);
		const chain = createSubagentGuardChain({
			cwd: dir,
			learnedErrorProvider: () => [
				{
					tool: "bash",
					fingerprint: "rg: C:/x: No such file or directory N",
					totalCount: 5,
					sessionCount: 3,
					matchedRuleIds: [],
					sampleErrorText: "rg: C:/x: No such file or directory",
					sampleArgs,
				},
			],
		});
		const first = await chain.beforeToolCall(call("bash", bashArgs, "le1"));
		expect(first?.block).toBe(true);
		expect(first?.reason).toMatch(/Learned-error guard/i);
		// Fire-once per (tool, args) per chain — immediate retry is allowed.
		const second = await chain.beforeToolCall(call("bash", bashArgs, "le1"));
		expect(second).toBeUndefined();
	});

	it("exposes eight subagent-propagated guard factories in fixed order", () => {
		expect(subagentGroundingGuardFactories("/tmp")).toHaveLength(8);
		const withLearned = bundleGroundingGuardFactories("/tmp", [() => {}]);
		expect(withLearned).toHaveLength(9);
	});

	it("parses the PIT_NO_SUBAGENT_GUARDS opt-out", () => {
		expect(areSubagentGuardsDisabled({} as NodeJS.ProcessEnv)).toBe(false);
		expect(areSubagentGuardsDisabled({ PIT_NO_SUBAGENT_GUARDS: "1" } as NodeJS.ProcessEnv)).toBe(true);
		expect(areSubagentGuardsDisabled({ PIT_NO_SUBAGENT_GUARDS: "true" } as NodeJS.ProcessEnv)).toBe(true);
		expect(areSubagentGuardsDisabled({ PIT_NO_SUBAGENT_GUARDS: "0" } as NodeJS.ProcessEnv)).toBe(false);
	});
});
