/**
 * Regression tests for the "ghost pasted image" bug: a clipboard image used to
 * be attached to the session at paste time, so deleting the `[Image #N]`
 * marker, clearing the draft (Ctrl+C), or abandoning the message did NOT
 * detach it — the image silently rode along on the next prompt, whatever it
 * was.
 *
 * Seam under test: the interactive composer buffers pasted images locally and
 * only attaches the marker-surviving subset to the session at submit time
 * (`attachPastedImagesFor`). The session-side drain-all contract for
 * programmatic callers is covered separately in
 * test/suite/agent-session-prompt.test.ts.
 *
 * Seam limit: the harness does not boot a real AgentSession (see
 * interactive-harness.ts), so `session` here is a structural stub with spies —
 * these tests assert what the composer hands the session, not what the
 * provider receives.
 */

import { describe, expect, test, vi } from "vitest";
import { imageMarker, reconcilePastedImages } from "../src/modes/interactive/pasted-images.ts";
import { createInteractiveHarness, type InteractiveHarness } from "./interactive-harness.ts";

// The paste handler reads the OS clipboard; pin it to a deterministic image.
vi.mock("../src/utils/clipboard-image.ts", () => ({
	readClipboardImage: vi.fn(async () => ({
		bytes: new Uint8Array([1, 2, 3]),
		mimeType: "image/png",
	})),
}));

describe("reconcilePastedImages", () => {
	test("keeps only images whose marker survives, by paste order", () => {
		const images = ["a", "b", "c"];
		expect(reconcilePastedImages("keep [Image #1] and [Image #3]", images)).toEqual(["a", "c"]);
		expect(reconcilePastedImages("[Image #2]", images)).toEqual(["b"]);
		expect(reconcilePastedImages("no markers at all", images)).toEqual([]);
	});

	test("empty buffer reconciles to empty regardless of text", () => {
		expect(reconcilePastedImages("[Image #1]", [])).toEqual([]);
	});

	test("marker matching is exact — a stale higher index does not match", () => {
		// One image buffered, but the text references a marker that no longer
		// maps to anything: nothing is sent.
		expect(reconcilePastedImages("[Image #2]", ["a"])).toEqual([]);
	});

	test("imageMarker renders the visible editor token", () => {
		expect(imageMarker(1)).toBe("[Image #1]");
		expect(imageMarker(12)).toBe("[Image #12]");
	});
});

/**
 * Extend the harness's structural session stub with the members the paste →
 * submit path touches, all spied.
 */
function armSession(harness: InteractiveHarness) {
	const internals = harness.internals();
	const session = internals.session;
	session.sessionId = "test-session";
	session.isCompacting = false;
	session.isStreaming = false;
	session.isFusing = false;
	session.isBusy = false;
	session.extensionRunner = { getCommand: () => undefined };
	session.attachImages = vi.fn();
	session.getAttachedImageCount = vi.fn(() => 0);
	session.prompt = vi.fn(async () => {});
	// Skip the working-loader construction on submit — irrelevant to the seam
	// and it would arm animation timers the stubbed session never stops.
	internals.workingVisible = false;
	// The harness skips init(); wire the submit handler the way init() does.
	internals.setupEditorSubmitHandler();
	return session as {
		attachImages: ReturnType<typeof vi.fn>;
		prompt: ReturnType<typeof vi.fn>;
	};
}

async function paste(harness: InteractiveHarness): Promise<void> {
	await harness.internals().handleClipboardImagePaste();
}

async function submit(harness: InteractiveHarness, text: string): Promise<void> {
	await harness.internals().defaultEditor.onSubmit(text);
}

describe("pasted images reconcile against the submitted draft", () => {
	test("paste alone attaches nothing to the session", async () => {
		const harness = createInteractiveHarness();
		try {
			const session = armSession(harness);
			await paste(harness);
			// The marker landed in the composer...
			expect(harness.internals().defaultEditor.getText()).toContain("[Image #1]");
			// ...but the image must stay local until a draft actually leaves.
			expect(session.attachImages).not.toHaveBeenCalled();
		} finally {
			harness.dispose();
		}
	});

	test("surviving marker: image is attached exactly once, before prompt()", async () => {
		const harness = createInteractiveHarness();
		try {
			const session = armSession(harness);
			await paste(harness);
			await submit(harness, "look at [Image #1] please");

			expect(session.attachImages).toHaveBeenCalledTimes(1);
			expect(session.attachImages).toHaveBeenCalledWith([
				{ type: "image", data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/png" },
			]);
			expect(session.prompt).toHaveBeenCalledWith("look at [Image #1] please");
			// Attach must land before the prompt that drains it.
			const attachOrder = session.attachImages.mock.invocationCallOrder[0];
			const promptOrder = session.prompt.mock.invocationCallOrder[0];
			expect(attachOrder).toBeLessThan(promptOrder);
		} finally {
			harness.dispose();
		}
	});

	test("deleted marker: the orphan image is discarded, not ghosted onto the prompt", async () => {
		const harness = createInteractiveHarness();
		try {
			const session = armSession(harness);
			await paste(harness);
			// User deleted the marker and typed something else entirely.
			await submit(harness, "actually, unrelated question");

			expect(session.attachImages).not.toHaveBeenCalled();
			expect(session.prompt).toHaveBeenCalledWith("actually, unrelated question");

			// And the orphan must not resurface on a LATER prompt either.
			await submit(harness, "second message");
			expect(session.attachImages).not.toHaveBeenCalled();
		} finally {
			harness.dispose();
		}
	});

	test("two pastes, one marker deleted: only the surviving image is sent", async () => {
		const harness = createInteractiveHarness();
		try {
			const session = armSession(harness);
			await paste(harness);
			await paste(harness);
			await submit(harness, "keep only [Image #2]");

			expect(session.attachImages).toHaveBeenCalledTimes(1);
			const sent = session.attachImages.mock.calls[0][0];
			expect(sent).toHaveLength(1);
		} finally {
			harness.dispose();
		}
	});

	test("Ctrl+C clears the draft AND the pending pasted images", async () => {
		const harness = createInteractiveHarness();
		try {
			const session = armSession(harness);
			const internals = harness.internals();
			await paste(harness);
			expect(internals.defaultEditor.getText()).toContain("[Image #1]");

			internals.handleCtrlC();
			internals.clearCtrlCHint(); // kill the ephemeral exit-hint timer
			expect(internals.defaultEditor.getText()).toBe("");

			// A fresh draft must not carry the cleared image.
			await submit(harness, "new message after clearing");
			expect(session.attachImages).not.toHaveBeenCalled();
			expect(session.prompt).toHaveBeenCalledWith("new message after clearing");
		} finally {
			harness.dispose();
		}
	});

	test("marker numbering restarts after a submit consumes the buffer", async () => {
		const harness = createInteractiveHarness();
		try {
			const session = armSession(harness);
			await paste(harness);
			await submit(harness, "send [Image #1]");
			expect(session.attachImages).toHaveBeenCalledTimes(1);

			// Next paste in a fresh draft starts back at #1, like the session
			// counter used to after a drain.
			await paste(harness);
			expect(harness.internals().defaultEditor.getText()).toContain("[Image #1]");
		} finally {
			harness.dispose();
		}
	});
});
