/**
 * N7 — inline digest + op:"read" recovery for subagent outputs.
 *
 * The blocking run/join payload the parent sees is now a small head+tail digest
 * (4KB default) plus a pointer citing op:"read"; the integral output is persisted
 * so op:"read" recovers the elided middle without re-spawning. This suite drives
 * the real coordinator extension tool via a faux provider (mirrors
 * coordinator-continue.test.ts) and pins the M18 pointer/description/constant tie.
 */

import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	createCoordinatorExtension,
	resolveSubagentMaxBytes,
	SUBAGENT_READ_OP,
	subagentReadPointer,
} from "../src/core/built-ins/coordinator-extension.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";

const MIDDLE_SENTINEL = "MIDDLE_SENTINEL_ELIDED_FROM_DIGEST";

/** A ~24KB output with a unique sentinel buried in the middle so we can prove the
 * digest elides it while op:"read" recovers it. */
function bigOutput(): string {
	const filler = "x".repeat(10_000);
	return `HEAD-START\n${filler}\n${MIDDLE_SENTINEL}\n${filler}\nTAIL-END`;
}

describe("coordinator N7 digest + op:read", () => {
	let faux: FauxProviderRegistration | undefined;
	afterEach(() => faux?.unregister());

	function buildTask(responses: Parameters<FauxProviderRegistration["setResponses"]>[0]) {
		faux = registerFauxProvider();
		faux.setResponses(responses);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const ext = createCoordinatorExtension({
			modelRegistry,
			getParentModel: () => model,
			getAvailableTools: () => [],
			convertToLlm: (messages) => convertToLlm(messages),
		});
		let taskDef:
			| {
					name: string;
					description: string;
					outputCap?: { maxBytes: number; mode: string };
					execute: (...a: unknown[]) => Promise<unknown>;
			  }
			| undefined;
		ext({
			registerTool: (def: { name: string }) => {
				taskDef = def as never;
			},
		} as never);
		if (!taskDef) throw new Error("task tool not registered");
		return taskDef;
	}

	const exec = (task: { execute: (...a: unknown[]) => Promise<unknown> }, params: Record<string, unknown>) =>
		task.execute("call", params, undefined, undefined, {});
	const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0].text;
	const isErr = (r: unknown): boolean => (r as { isError: boolean }).isError;

	it("run of a large output returns a bounded digest + a read pointer (no middle)", async () => {
		const task = buildTask([fauxAssistantMessage(bigOutput())]);
		const run = await exec(task, { op: "run", name: "big", prompt: "produce a lot" });
		expect(isErr(run)).toBe(false);
		const digest = textOf(run);
		// Digest keeps head + tail but elides the middle sentinel.
		expect(digest).toContain("HEAD-START");
		expect(digest).toContain("TAIL-END");
		expect(digest).not.toContain(MIDDLE_SENTINEL);
		// Pointer cites the exact op and the handle, and the payload is far under 24KB.
		expect(digest).toContain(`op:"${SUBAGENT_READ_OP}"`);
		expect(digest).toContain('name:"big"');
		expect(Buffer.byteLength(digest, "utf8")).toBeLessThan(8 * 1024);
	});

	it('op:"read" recovers the integral output including the elided middle', async () => {
		const task = buildTask([fauxAssistantMessage(bigOutput())]);
		await exec(task, { op: "run", name: "big", prompt: "produce a lot" });
		const read = await exec(task, { op: SUBAGENT_READ_OP, name: "big" });
		expect(isErr(read)).toBe(false);
		const full = textOf(read);
		expect(full).toContain("HEAD-START");
		expect(full).toContain(MIDDLE_SENTINEL);
		expect(full).toContain("TAIL-END");
	});

	it("a small output fits the digest verbatim with no pointer, and read still returns it", async () => {
		const task = buildTask([fauxAssistantMessage("tiny answer")]);
		const run = await exec(task, { op: "run", name: "small", prompt: "brief" });
		expect(textOf(run)).toBe("tiny answer");
		expect(textOf(run)).not.toContain(`op:"${SUBAGENT_READ_OP}"`);
		const read = await exec(task, { op: SUBAGENT_READ_OP, name: "small" });
		expect(textOf(read)).toContain("tiny answer");
	});

	it('op:"read" of an unknown handle errors clearly', async () => {
		const task = buildTask([fauxAssistantMessage("ok")]);
		const read = await exec(task, { op: SUBAGENT_READ_OP, name: "ghost" });
		expect(isErr(read)).toBe(true);
		expect(textOf(read)).toContain("no stored output");
	});

	it('op:"read" without a name asks for one', async () => {
		const task = buildTask([fauxAssistantMessage("ok")]);
		const read = await exec(task, { op: SUBAGENT_READ_OP });
		expect(isErr(read)).toBe(true);
		expect(textOf(read)).toContain("needs `name`");
	});

	it("M18: pointer, tool description, and schema op are bound to one shared constant", () => {
		const task = buildTask([fauxAssistantMessage("ok")]);
		expect(SUBAGENT_READ_OP).toBe("read");
		// Pointer cites the exact op + handle from the shared constant.
		const pointer = subagentReadPointer("myhandle", 5000);
		expect(pointer).toContain(`op:"${SUBAGENT_READ_OP}"`);
		expect(pointer).toContain('name:"myhandle"');
		// The tool description announces the same op verbatim.
		expect(task.description).toContain(`op:"${SUBAGENT_READ_OP}"`);
	});

	it("task tool carries a 256KB head+tail outputCap so read survives the generic net", () => {
		const task = buildTask([fauxAssistantMessage("ok")]);
		// Mirrors recall_tool_output: the wrap layer caps op:"read" at 256KB head+tail
		// instead of the generic 64KB head-only net, so a large recovered output keeps
		// both ends.
		expect(task.outputCap?.mode).toBe("headTail");
		expect(task.outputCap?.maxBytes).toBe(256 * 1024);
	});

	it("PIT_SUBAGENT_MAX_BYTES still overrides the (now smaller, 4KB) inline cap", () => {
		expect(resolveSubagentMaxBytes({} as NodeJS.ProcessEnv)).toBe(4 * 1024);
		expect(resolveSubagentMaxBytes({ PIT_SUBAGENT_MAX_BYTES: "8192" } as unknown as NodeJS.ProcessEnv)).toBe(8192);
		expect(resolveSubagentMaxBytes({ PIT_SUBAGENT_MAX_BYTES: "  " } as unknown as NodeJS.ProcessEnv)).toBe(4 * 1024);
		expect(resolveSubagentMaxBytes({ PIT_SUBAGENT_MAX_BYTES: "bogus" } as unknown as NodeJS.ProcessEnv)).toBe(
			4 * 1024,
		);
	});
});
