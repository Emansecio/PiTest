import { describe, expect, it } from "vitest";
import { settleOrAbort } from "../src/utils/abort-race.ts";

describe("settleOrAbort", () => {
	it("resolves with the promise value when the signal never fires", async () => {
		const controller = new AbortController();
		await expect(settleOrAbort(Promise.resolve(42), controller.signal)).resolves.toBe(42);
	});

	it("returns the promise unchanged when no signal is given", async () => {
		await expect(settleOrAbort(Promise.resolve("ok"), undefined)).resolves.toBe("ok");
	});

	it("propagates the promise's own rejection when the signal never fires", async () => {
		const controller = new AbortController();
		await expect(settleOrAbort(Promise.reject(new Error("boom")), controller.signal)).rejects.toThrow("boom");
	});

	it("rejects with the abort error the instant the signal fires, even if the hook never settles", async () => {
		const controller = new AbortController();
		const marker = new Error("aborted-sentinel");
		// A hook parked forever (the wedge scenario): the run loop must not wait on it.
		const wedged = new Promise<void>(() => {});
		const start = Date.now();
		const raced = settleOrAbort(wedged, controller.signal, () => marker);
		controller.abort();
		await expect(raced).rejects.toBe(marker);
		expect(Date.now() - start).toBeLessThan(2000);
	});

	it("rejects immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const marker = new Error("pre-aborted");
		const wedged = new Promise<void>(() => {});
		await expect(settleOrAbort(wedged, controller.signal, () => marker)).rejects.toBe(marker);
	});

	it("does not leak an unhandledRejection when the abandoned hook later rejects", async () => {
		const controller = new AbortController();
		let rejectHook: (e: Error) => void = () => {};
		const hook = new Promise<void>((_resolve, reject) => {
			rejectHook = reject;
		});
		const raced = settleOrAbort(hook, controller.signal, () => new Error("abort"));
		controller.abort();
		await expect(raced).rejects.toThrow("abort");
		// The detached hook rejects after we already aborted — must be swallowed.
		rejectHook(new Error("late hook failure"));
		// Give the microtask queue a tick; if the rejection were unhandled the test
		// process would flag it.
		await new Promise((r) => setTimeout(r, 10));
	});
});
