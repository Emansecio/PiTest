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
		emit,
	} as unknown as AgentSession;
	const deliver = (AgentSession.prototype as any)._deliverAsyncResult.bind(self);
	return { deliver, followUp, runAgentPrompt, emit };
}

/** Run `fn` with PIT_ASYNC_REINJECT forced to `value`, restoring the prior env after. */
function withReinject(value: string | undefined, fn: () => void): void {
	const prev = process.env.PIT_ASYNC_REINJECT;
	if (value === undefined) delete process.env.PIT_ASYNC_REINJECT;
	else process.env.PIT_ASYNC_REINJECT = value;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env.PIT_ASYNC_REINJECT;
		else process.env.PIT_ASYNC_REINJECT = prev;
	}
}

describe("_deliverAsyncResult routing", () => {
	it("default (no env): emits the status event but does NOT re-inject — Claude Code parity", () => {
		withReinject(undefined, () => {
			const { deliver, followUp, runAgentPrompt, emit } = fakeSession({ busy: false });
			expect(deliver("t1", "RESULT", "done")).toBe(false);
			expect(followUp).not.toHaveBeenCalled();
			expect(runAgentPrompt).not.toHaveBeenCalled();
			expect(emit).toHaveBeenCalledWith({ type: "subagent_complete", handle: "t1", status: "done" });
		});
	});

	it("opt-in PIT_ASYNC_REINJECT=1, busy → followUp (guaranteed to run a turn before the agent stops), no new turn", () => {
		// Must be followUp, not injectPassive: a passive message is dropped when the
		// current turn stops without more tool calls (common in fan-out), silently
		// losing the result while the handle is marked delivered.
		withReinject("1", () => {
			const { deliver, followUp, runAgentPrompt, emit } = fakeSession({ busy: true });
			expect(deliver("t1", "RESULT", "done")).toBe(true);
			expect(followUp).toHaveBeenCalledTimes(1);
			expect(followUp.mock.calls[0][0].content[0].text).toContain("RESULT");
			expect(runAgentPrompt).not.toHaveBeenCalled();
			expect(emit).toHaveBeenCalledWith({ type: "subagent_complete", handle: "t1", status: "done" });
		});
	});

	it("opt-in PIT_ASYNC_REINJECT=1, idle → _runAgentPrompt (spawns a fresh turn)", () => {
		withReinject("1", () => {
			const { deliver, followUp, runAgentPrompt } = fakeSession({ busy: false });
			expect(deliver("t1", "RESULT", "done")).toBe(true);
			expect(runAgentPrompt).toHaveBeenCalledTimes(1);
			expect(runAgentPrompt.mock.calls[0][0].content[0].text).toContain("RESULT");
			expect(followUp).not.toHaveBeenCalled();
		});
	});
});
