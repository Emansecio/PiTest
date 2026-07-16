/**
 * Run-slot budget (coordinator/slots.ts) — the single concurrency chokepoint.
 *
 * Covers: cap enforcement through withRunSlot, queue-full rejection, abort
 * while queued, lease-context propagation (withoutLease), and the anti-deadlock
 * yield/reacquire when a subagent spawns a nested subagent while every slot is
 * taken (the depth>=2 scenario that deadlocked the old per-tool semaphore).
 */

import type { AgentMessage, AgentTool } from "@pit/agent-core";
import { type FauxProviderRegistration, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@pit/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SubagentRegistry } from "../src/core/coordinator/registry.js";
import {
	currentLease,
	slotStats,
	withoutLease,
	withRunSlot,
	yieldRunSlotWhile,
} from "../src/core/coordinator/slots.js";
import { type SpawnSubagentDependencies, spawnSubagent } from "../src/core/coordinator/spawn.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const ENV_KEYS = ["PIT_SUBAGENT_MAX_CONCURRENCY", "PIT_SUBAGENT_MAX_QUEUE"] as const;
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: (typeof ENV_KEYS)[number], value: string): void {
	if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
	process.env[key] = value;
}

afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	savedEnv.clear();
});

describe("withRunSlot", () => {
	it("caps concurrent runs at PIT_SUBAGENT_MAX_CONCURRENCY", async () => {
		setEnv("PIT_SUBAGENT_MAX_CONCURRENCY", "1");
		let inFlight = 0;
		let maxInFlight = 0;
		const fn = async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await sleep(25);
			inFlight--;
		};
		await Promise.all([withRunSlot(undefined, fn), withRunSlot(undefined, fn), withRunSlot(undefined, fn)]);
		expect(maxInFlight).toBe(1);
	});

	it("rejects with a queue-full error past PIT_SUBAGENT_MAX_QUEUE", async () => {
		setEnv("PIT_SUBAGENT_MAX_CONCURRENCY", "1");
		setEnv("PIT_SUBAGENT_MAX_QUEUE", "1");
		let release: () => void = () => {};
		const holdDone = withRunSlot(
			undefined,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await sleep(5); // slot is held
		const queued = withRunSlot(undefined, async () => {});
		await sleep(5); // waiter occupies the whole queue
		await expect(withRunSlot(undefined, async () => {})).rejects.toThrow(/queue full/);
		release();
		await Promise.all([holdDone, queued]);
	});

	it("rejects immediately when the signal aborts while queued", async () => {
		setEnv("PIT_SUBAGENT_MAX_CONCURRENCY", "1");
		let release: () => void = () => {};
		const holdDone = withRunSlot(
			undefined,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await sleep(5);
		const controller = new AbortController();
		const queued = withRunSlot(controller.signal, async () => {});
		await sleep(5);
		controller.abort(new Error("aborted: test"));
		await expect(queued).rejects.toThrow(/aborted/);
		release();
		await holdDone;
	});

	it("exposes the lease to the run and strips it inside withoutLease", async () => {
		let insideRun: unknown;
		let insideDetached: unknown;
		await withRunSlot(undefined, async () => {
			insideRun = currentLease();
			await withoutLease(async () => {
				insideDetached = currentLease();
			});
		});
		expect(insideRun).toBeDefined();
		expect(insideDetached).toBeUndefined();
		expect(currentLease()).toBeUndefined();
	});

	it("waits for all concurrent descendants before reacquiring the parent slot", async () => {
		setEnv("PIT_SUBAGENT_MAX_CONCURRENCY", "1");
		const completed: string[] = [];
		const run = withRunSlot(undefined, async () => {
			await Promise.all([
				withRunSlot(undefined, async () => {
					completed.push("sibling-a");
				}),
				withRunSlot(undefined, async () => {
					// This second sibling delegates again. Without descendant ref-counting,
					// sibling A's completion reacquired the blocked parent slot first and
					// this grandchild deadlocked forever at concurrency=1.
					await withRunSlot(undefined, async () => {
						completed.push("grandchild");
					});
					completed.push("sibling-b");
				}),
			]);
			completed.push("parent");
		});
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				run,
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(new Error("nested sibling delegation deadlocked")), 2_000);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		expect(completed).toContain("grandchild");
		expect(completed.at(-1)).toBe("parent");
	});

	it("yields the parent slot while joining detached descendant work", async () => {
		setEnv("PIT_SUBAGENT_MAX_CONCURRENCY", "1");
		const completed: string[] = [];
		await withRunSlot(undefined, async () => {
			const detached = withoutLease(() =>
				withRunSlot(undefined, async () => {
					completed.push("detached");
				}),
			);
			await yieldRunSlotWhile(undefined, () => detached);
			completed.push("parent");
		});
		expect(completed).toEqual(["detached", "parent"]);
	});

	it("reports active/queued in slotStats while a run is held", async () => {
		setEnv("PIT_SUBAGENT_MAX_CONCURRENCY", "1");
		let release: () => void = () => {};
		const holdDone = withRunSlot(
			undefined,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await sleep(5);
		const queued = withRunSlot(undefined, async () => {});
		await sleep(5);
		const stats = slotStats();
		expect(stats.active).toBeGreaterThanOrEqual(1);
		expect(stats.queued).toBeGreaterThanOrEqual(1);
		release();
		await Promise.all([holdDone, queued]);
	});
});

describe("nested spawn anti-deadlock (yield/reacquire)", () => {
	interface Rig {
		faux: FauxProviderRegistration;
		deps: SpawnSubagentDependencies;
		dispose: () => void;
	}

	function createRig(tools: AgentTool[]): Rig {
		const faux = registerFauxProvider();
		faux.setResponses([]);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const registry = new SubagentRegistry();
		return {
			faux,
			deps: {
				registry,
				model,
				modelRegistry,
				availableTools: tools,
				convertToLlm: (messages: AgentMessage[]) => convertToLlm(messages),
			},
			dispose: () => faux.unregister(),
		};
	}

	it("a child that spawns a grandchild completes with a single slot (no deadlock)", async () => {
		setEnv("PIT_SUBAGENT_MAX_CONCURRENCY", "1");
		// The delegate tool spawns a nested subagent from INSIDE the child's turn —
		// with the old per-tool semaphore and one slot, the child (holding the only
		// slot while blocked on the tool) would wait forever for the grandchild.
		let rig: Rig | undefined;
		const delegate: AgentTool = {
			name: "delegate",
			label: "delegate",
			description: "spawns a nested subagent",
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => {
				const result = await spawnSubagent((rig as Rig).deps, { prompt: "nested probe", taskName: "grandchild" });
				return { content: [{ type: "text", text: result.output }], details: {} };
			},
		};
		rig = createRig([delegate]);
		try {
			rig.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("delegate", { value: "go" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("grand done"),
				fauxAssistantMessage("child done"),
			]);
			const result = await spawnSubagent(rig.deps, {
				prompt: "delegate then answer",
				taskName: "child",
				allowedTools: ["delegate"],
			});
			expect(result.output).toBe("child done");
			expect(rig.deps.registry.list().find((r) => r.taskName === "grandchild")?.status).toBe("completed");
		} finally {
			rig.dispose();
		}
	}, 15_000);
});
