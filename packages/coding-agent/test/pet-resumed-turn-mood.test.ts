/**
 * What the pet goes back to when a paused turn resumes.
 *
 * The pause the user sees most is a permission prompt, and permission is asked
 * for a tool that is ALREADY pending — granting it leaves that tool running.
 * Resuming on `isBusy` alone gets exactly that case backwards: the mascot drops
 * out of the working hop into the calmer thinking scan while the tool it was
 * hopping for is still going, and nothing corrects it until the NEXT tool starts.
 * The rule here mirrors the one `tool_execution_end` applies — only an empty
 * `pendingTools` means the work is over.
 */

import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function proto<T>(name: string): T {
	return Reflect.get(InteractiveMode.prototype, name) as T;
}

const beginUserInputWait = proto<(this: any, message: string) => () => void>("beginUserInputWait");

function fakeThis(options: { busy: boolean; pending: number }) {
	const moods: string[] = [];
	return {
		moods,
		userInputPauseDepth: 0,
		userInputPauseMessage: null as string | null,
		applyUserInputPause: vi.fn(),
		resumedTurnMood: proto<(this: any) => string>("resumedTurnMood"),
		petCompanion: { setMood: (state: string) => moods.push(state) },
		session: { isBusy: options.busy },
		pendingTools: new Map(Array.from({ length: options.pending }, (_, i) => [`t${i}`, {}])),
	};
}

describe("mood after a user-input pause", () => {
	test("a tool still in flight resumes the working hop, not thinking", () => {
		const self = fakeThis({ busy: true, pending: 1 });
		const release = beginUserInputWait.call(self, "permission");
		expect(self.moods).toEqual(["alert"]);
		release();
		expect(self.moods).toEqual(["alert", "working"]);
	});

	test("no tools left resumes reasoning", () => {
		const self = fakeThis({ busy: true, pending: 0 });
		beginUserInputWait.call(self, "permission")();
		expect(self.moods.at(-1)).toBe("thinking");
	});

	test("a turn that ended while the prompt was up settles", () => {
		const self = fakeThis({ busy: false, pending: 0 });
		beginUserInputWait.call(self, "ask")();
		expect(self.moods.at(-1)).toBe("idle");
	});

	test("nested prompts only resume once, on the last release", () => {
		const self = fakeThis({ busy: true, pending: 2 });
		const outer = beginUserInputWait.call(self, "ask");
		const inner = beginUserInputWait.call(self, "permission");
		inner();
		// The inner release still leaves a prompt up — no resume yet.
		expect(self.moods).toEqual(["alert"]);
		outer();
		expect(self.moods).toEqual(["alert", "working"]);
	});

	test("a release is idempotent — calling it twice resumes once", () => {
		const self = fakeThis({ busy: true, pending: 1 });
		const release = beginUserInputWait.call(self, "permission");
		release();
		release();
		expect(self.moods).toEqual(["alert", "working"]);
	});
});
