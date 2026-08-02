/**
 * Sequential ask queue in the interactive mode.
 *
 * `handleAskRequest` used to auto-answer any request that arrived while a picker
 * was already open (`computeAutoAnswer` — recommended-or-first). A parallel batch
 * of tool calls therefore cost the user every choice but the first: in `confirm`
 * mode, N mutations produced one prompt and N-1 silent Denies. Requests now queue
 * FIFO and are presented one at a time.
 *
 * Driven through the REAL mode: real `UserInputBus`, real `createAskPicker`, real
 * TUI input path (`terminal.sendInput` → focused component).
 */

import { setKeybindings } from "@pit/tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { AskOptionsAnswer, UserInputBus } from "../src/core/user-input-bus.ts";
import { createInteractiveHarness, type InteractiveHarness } from "./interactive-harness.ts";

const ENTER = "\r";
const ESC = "\x1b";

let harness: InteractiveHarness | undefined;

beforeAll(() => {
	// The picker renders real keybinding hints and reads `tui.select.*`.
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	harness?.dispose();
	harness = undefined;
});

/**
 * Real mode + real bus. The harness deliberately skips `init()`, so the bus
 * binding (normally done there) is wired explicitly; `dispose()` still tears it
 * down, because `stop()` runs the same signal-cleanup handlers.
 */
function boot(): { h: InteractiveHarness; bus: UserInputBus } {
	const h = createInteractiveHarness();
	harness = h;
	const internals = h.internals();
	internals.bindUserInputBus();
	return { h, bus: internals.userInputBus as UserInputBus };
}

function ask(bus: UserInputBus, question: string, labels: string[], header?: string): Promise<AskOptionsAnswer> {
	return bus.askOptions({
		question,
		header,
		options: labels.map((label) => ({ label })),
		source: { toolName: "ask" },
	});
}

describe("ask queue — sequential presentation", () => {
	it("presents a colliding request only after the open one resolves, in arrival order", async () => {
		const { h, bus } = boot();

		const first = ask(bus, "First question?", ["A1", "A2"]);
		const second = ask(bus, "Second question?", ["B1"]);
		const third = ask(bus, "Third question?", ["C1"]);

		// Only the first is on screen; the others wait their turn.
		expect(h.editorText()).toContain("First question?");
		expect(h.editorText()).not.toContain("Second question?");
		expect(h.editorText()).not.toContain("Third question?");

		h.sendKey(ENTER); // confirm A1
		expect(await first).toMatchObject({ picked: ["A1"], cancelled: false });

		expect(h.editorText()).toContain("Second question?");
		expect(h.editorText()).not.toContain("Third question?");

		h.sendKey(ENTER);
		expect(await second).toMatchObject({ picked: ["B1"], cancelled: false });

		expect(h.editorText()).toContain("Third question?");
		h.sendKey(ENTER);
		expect(await third).toMatchObject({ picked: ["C1"], cancelled: false });
	});

	it("never auto-answers a collision (the old behaviour: recommended-or-first)", async () => {
		const { h, bus } = boot();

		// "Deny" first + no `recommended` is the fail-closed ordering every gate
		// uses; the old collision path would have picked it without asking.
		const first = ask(bus, "First question?", ["A1"]);
		const second = ask(bus, "Approve?", ["Deny", "Allow"]);

		let settled = false;
		void second.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);

		h.sendKey(ENTER);
		await first;
		// Now it is the user's decision, and the user can pick the non-default.
		expect(h.editorText()).toContain("Approve?");
		h.sendKey("2"); // quick-select → "Allow"
		expect(await second).toMatchObject({ picked: ["Allow"], cancelled: false });
	});

	it("marks the open prompt with a dense +N queued badge that tracks the depth", async () => {
		const { h, bus } = boot();

		const first = ask(bus, "First question?", ["A1"], "confirm mode");
		expect(h.editorText()).toContain("confirm mode");
		expect(h.editorText()).not.toContain("queued");

		const second = ask(bus, "Second question?", ["B1"]);
		expect(h.editorText()).toContain("confirm mode·+1 queued");

		const third = ask(bus, "Third question?", ["C1"]);
		expect(h.editorText()).toContain("confirm mode·+2 queued");

		h.sendKey(ENTER);
		await first;
		// The second prompt has no header of its own: the badge becomes the chip.
		expect(h.editorText()).toContain("+1 queued");
		h.sendKey(ENTER);
		await second;
		expect(h.editorText()).not.toContain("queued");
		h.sendKey(ENTER);
		await third;
	});
});

describe("ask queue — cancellation drains everything", () => {
	it("Esc on the open picker cancels it AND the whole queue", async () => {
		const { h, bus } = boot();

		const first = ask(bus, "First question?", ["A1"]);
		const second = ask(bus, "Second question?", ["B1"]);
		const third = ask(bus, "Third question?", ["C1"]);

		h.sendKey(ESC);

		expect(await first).toMatchObject({ picked: [], cancelled: true });
		expect(await second).toMatchObject({ picked: [], cancelled: true });
		expect(await third).toMatchObject({ picked: [], cancelled: true });

		// Nothing left on the composer slot — no prompt from the drained queue.
		expect(h.editorText()).not.toContain("First question?");
		expect(h.editorText()).not.toContain("Second question?");
		expect(h.internals().askQueue).toHaveLength(0);
		expect(h.internals().pendingAskRequest).toBeUndefined();
	});

	it("a turn interrupt (bus.cancelAll) tears the open picker down and drops the queue", async () => {
		const { h, bus } = boot();

		const first = ask(bus, "First question?", ["A1"]);
		const second = ask(bus, "Second question?", ["B1"]);
		expect(h.editorText()).toContain("First question?");

		// Exactly what `session.interrupt()` / `session.abort()` do.
		bus.cancelAll("interrupt");

		expect(await first).toMatchObject({ cancelled: true });
		expect(await second).toMatchObject({ cancelled: true });
		expect(h.editorText()).not.toContain("First question?");
		expect(h.internals().askQueue).toHaveLength(0);
		expect(h.internals().pendingAskRequest).toBeUndefined();
	});

	it("an explicit pick (not a cancel) still advances to the next request", async () => {
		const { h, bus } = boot();

		const first = ask(bus, "First question?", ["Deny", "Allow"]);
		const second = ask(bus, "Second question?", ["B1"]);

		h.sendKey(ENTER); // "Deny" — a decision, not a cancellation
		expect(await first).toMatchObject({ picked: ["Deny"] });
		expect(h.editorText()).toContain("Second question?");
		h.sendKey(ENTER);
		expect(await second).toMatchObject({ picked: ["B1"] });
	});

	it("dispose drains the queue and answers every waiter (no leak, no hang)", async () => {
		const { h, bus } = boot();

		const first = ask(bus, "First question?", ["A1"]);
		const second = ask(bus, "Second question?", ["B1"]);

		h.dispose();
		harness = undefined;

		expect(await first).toMatchObject({ cancelled: true });
		expect(await second).toMatchObject({ cancelled: true });
		expect(h.internals().askQueue).toHaveLength(0);
	});
});
