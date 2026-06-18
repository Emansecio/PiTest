import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";

function fakeSession(opts: { busy: boolean }) {
	const followUp = vi.fn();
	const runAgentPrompt = vi.fn().mockResolvedValue(undefined);
	const emit = vi.fn();
	const self = {
		agent: { followUp },
		get isBusy() {
			return opts.busy;
		},
		_runAgentPrompt: runAgentPrompt,
		_emit: emit,
	} as unknown as AgentSession;
	const deliver = (AgentSession.prototype as any)._deliverAsyncResult.bind(self);
	return { deliver, followUp, runAgentPrompt, emit };
}

describe("_deliverAsyncResult routing", () => {
	it("busy → followUp (guaranteed to run a turn before the agent stops), no new turn", () => {
		// Must be followUp, not injectPassive: a passive message is dropped when the
		// current turn stops without more tool calls (common in fan-out), silently
		// losing the result while the handle is marked delivered.
		const { deliver, followUp, runAgentPrompt, emit } = fakeSession({ busy: true });
		expect(deliver("t1", "RESULT", "done")).toBe(true);
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(followUp.mock.calls[0][0].content[0].text).toContain("RESULT");
		expect(runAgentPrompt).not.toHaveBeenCalled();
		expect(emit).toHaveBeenCalledWith({ type: "subagent_complete", handle: "t1", status: "done" });
	});

	it("idle → _runAgentPrompt (spawns a fresh turn)", () => {
		const { deliver, followUp, runAgentPrompt } = fakeSession({ busy: false });
		expect(deliver("t1", "RESULT", "done")).toBe(true);
		expect(runAgentPrompt).toHaveBeenCalledTimes(1);
		expect(runAgentPrompt.mock.calls[0][0].content[0].text).toContain("RESULT");
		expect(followUp).not.toHaveBeenCalled();
	});

	it("kill-switch PIT_NO_ASYNC_REINJECT=1 emits the event but does not re-inject", () => {
		const prev = process.env.PIT_NO_ASYNC_REINJECT;
		process.env.PIT_NO_ASYNC_REINJECT = "1";
		try {
			const { deliver, followUp, runAgentPrompt, emit } = fakeSession({ busy: false });
			expect(deliver("t1", "RESULT", "done")).toBe(false);
			expect(followUp).not.toHaveBeenCalled();
			expect(runAgentPrompt).not.toHaveBeenCalled();
			expect(emit).toHaveBeenCalledWith({ type: "subagent_complete", handle: "t1", status: "done" });
		} finally {
			if (prev === undefined) delete process.env.PIT_NO_ASYNC_REINJECT;
			else process.env.PIT_NO_ASYNC_REINJECT = prev;
		}
	});
});
