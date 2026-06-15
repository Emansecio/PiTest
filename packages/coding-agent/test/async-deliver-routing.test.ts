import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";

function fakeSession(opts: { busy: boolean }) {
	const injectPassive = vi.fn();
	const runAgentPrompt = vi.fn().mockResolvedValue(undefined);
	const emit = vi.fn();
	const self = {
		agent: { injectPassive },
		get isBusy() {
			return opts.busy;
		},
		_runAgentPrompt: runAgentPrompt,
		_emit: emit,
	} as unknown as AgentSession;
	const deliver = (AgentSession.prototype as any)._deliverAsyncResult.bind(self);
	return { deliver, injectPassive, runAgentPrompt, emit };
}

describe("_deliverAsyncResult routing", () => {
	it("busy → injectPassive (drains on the current turn), no new turn", () => {
		const { deliver, injectPassive, runAgentPrompt, emit } = fakeSession({ busy: true });
		expect(deliver("t1", "RESULT", "done")).toBe(true);
		expect(injectPassive).toHaveBeenCalledTimes(1);
		expect(injectPassive.mock.calls[0][0].content[0].text).toContain("RESULT");
		expect(runAgentPrompt).not.toHaveBeenCalled();
		expect(emit).toHaveBeenCalledWith({ type: "subagent_complete", handle: "t1", status: "done" });
	});

	it("idle → _runAgentPrompt (spawns a fresh turn)", () => {
		const { deliver, injectPassive, runAgentPrompt } = fakeSession({ busy: false });
		expect(deliver("t1", "RESULT", "done")).toBe(true);
		expect(runAgentPrompt).toHaveBeenCalledTimes(1);
		expect(runAgentPrompt.mock.calls[0][0].content[0].text).toContain("RESULT");
		expect(injectPassive).not.toHaveBeenCalled();
	});

	it("kill-switch PIT_NO_ASYNC_REINJECT=1 emits the event but does not re-inject", () => {
		const prev = process.env.PIT_NO_ASYNC_REINJECT;
		process.env.PIT_NO_ASYNC_REINJECT = "1";
		try {
			const { deliver, injectPassive, runAgentPrompt, emit } = fakeSession({ busy: false });
			expect(deliver("t1", "RESULT", "done")).toBe(false);
			expect(injectPassive).not.toHaveBeenCalled();
			expect(runAgentPrompt).not.toHaveBeenCalled();
			expect(emit).toHaveBeenCalledWith({ type: "subagent_complete", handle: "t1", status: "done" });
		} finally {
			if (prev === undefined) delete process.env.PIT_NO_ASYNC_REINJECT;
			else process.env.PIT_NO_ASYNC_REINJECT = prev;
		}
	});
});
