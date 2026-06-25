import { describe, expect, it } from "vitest";
import { createConnectGuard } from "../src/utils/connect-guard.ts";

const never = (): Promise<never> => new Promise<never>(() => {});

describe("createConnectGuard", () => {
	it("resolves a normal connect and leaves the signal unaborted", async () => {
		const guard = createConnectGuard(undefined, 10_000);
		await expect(guard.settle(Promise.resolve("ok"))).resolves.toBe("ok");
		expect(guard.signal.aborted).toBe(false);
		guard.dispose();
	});

	it("rejects promptly on user abort even when the connect never settles (the wedge)", async () => {
		const ctrl = new AbortController();
		const guard = createConnectGuard(ctrl.signal, 10_000);
		const settled = guard.settle(never());
		ctrl.abort();
		await expect(settled).rejects.toThrow(/aborted/i);
		// Combined signal is aborted too → the SDK socket is torn down, not orphaned.
		expect(guard.signal.aborted).toBe(true);
		guard.dispose();
	});

	it("rejects immediately when the user signal is already aborted", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		const guard = createConnectGuard(ctrl.signal, 10_000);
		expect(guard.signal.aborted).toBe(true);
		await expect(guard.settle(never())).rejects.toThrow(/aborted/i);
		guard.dispose();
	});

	it("rejects with a retryable timeout error when the connect stalls past the budget", async () => {
		const guard = createConnectGuard(undefined, 15);
		await expect(guard.settle(never())).rejects.toThrow(/timed out/i);
		expect(guard.signal.aborted).toBe(true);
		guard.dispose();
	});

	it("propagates a real connect error unchanged (not masked as a timeout)", async () => {
		const guard = createConnectGuard(undefined, 10_000);
		await expect(guard.settle(Promise.reject(new Error("boom 401")))).rejects.toThrow("boom 401");
		guard.dispose();
	});

	it("keeps forwarding user abort to the signal during the body phase (after connect)", async () => {
		const ctrl = new AbortController();
		const guard = createConnectGuard(ctrl.signal, 10_000);
		await guard.settle(Promise.resolve("headers"));
		expect(guard.signal.aborted).toBe(false);
		// Connect succeeded; a later interrupt during the body must still abort the
		// shared signal so the SDK body fetch is cancelled.
		ctrl.abort();
		expect(guard.signal.aborted).toBe(true);
		guard.dispose();
	});

	it("a late rejection from the orphaned connect does not throw out of the guard", async () => {
		const ctrl = new AbortController();
		const guard = createConnectGuard(ctrl.signal, 10_000);
		let rejectLater: (e: Error) => void = () => {};
		const hung = new Promise<never>((_resolve, reject) => {
			rejectLater = reject;
		});
		const settled = guard.settle(hung);
		ctrl.abort();
		await expect(settled).rejects.toThrow(/aborted/i);
		// The detached create rejects afterwards; must be swallowed (no unhandled).
		rejectLater(new Error("late socket error"));
		await new Promise((r) => setTimeout(r, 5));
		guard.dispose();
	});
});
