import type { Model } from "@pit/ai";
import { describe, expect, it, vi } from "vitest";
import {
	CACHE_KEEPALIVE_INTERVAL_MS,
	CacheKeepalive,
	type CacheKeepaliveGates,
	type CacheKeepaliveTimer,
	modelHasShortCacheRetention,
} from "../src/core/cache-keepalive.js";

/** Yields to the real macrotask queue so any pending microtasks (the class's internal `await`s) settle before assertions. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface FakeTimerEntry {
	callback: () => void;
	delayMs: number;
}

/** Fully fake, synchronously-controllable timer — no real setTimeout involved in scheduling. */
function createFakeTimer(): CacheKeepaliveTimer & {
	pendingCount: () => number;
	pendingDelays: () => number[];
	fireLatest: () => void;
} {
	let nextId = 1;
	const entries = new Map<number, FakeTimerEntry>();
	return {
		now: () => 0,
		setTimer: vi.fn((callback: () => void, delayMs: number) => {
			const id = nextId++;
			entries.set(id, { callback, delayMs });
			return id;
		}),
		clearTimer: vi.fn((handle: unknown) => {
			entries.delete(handle as number);
		}),
		pendingCount: () => entries.size,
		pendingDelays: () => [...entries.values()].map((e) => e.delayMs),
		fireLatest: () => {
			const ids = [...entries.keys()];
			const id = ids[ids.length - 1];
			if (id === undefined) throw new Error("no pending timer to fire");
			const entry = entries.get(id);
			entries.delete(id);
			entry?.callback();
		},
	};
}

function createGates(overrides: Partial<CacheKeepaliveGates> = {}): CacheKeepaliveGates {
	return {
		isEnabled: () => true,
		isEligibleModel: () => true,
		isIdle: () => true,
		hasLargeEnoughPrefix: () => true,
		isCompactionInFlight: () => false,
		...overrides,
	};
}

describe("CacheKeepalive", () => {
	it("arms a timer at CACHE_KEEPALIVE_INTERVAL_MS when scheduleIdle() is called", () => {
		const timer = createFakeTimer();
		const ping = vi.fn().mockResolvedValue(true);
		const kp = new CacheKeepalive({ timer, gates: createGates(), ping });

		kp.scheduleIdle();

		expect(timer.setTimer).toHaveBeenCalledTimes(1);
		expect(timer.pendingDelays()).toEqual([CACHE_KEEPALIVE_INTERVAL_MS]);
		expect(ping).not.toHaveBeenCalled();
	});

	it("does not arm a timer when the kill-switch gate is off", () => {
		const timer = createFakeTimer();
		const ping = vi.fn().mockResolvedValue(true);
		const kp = new CacheKeepalive({ timer, gates: createGates({ isEnabled: () => false }), ping });

		kp.scheduleIdle();

		expect(timer.setTimer).not.toHaveBeenCalled();
	});

	it("re-arming scheduleIdle() (e.g. once per post-run check) does not spawn extra timers", () => {
		const timer = createFakeTimer();
		const ping = vi.fn().mockResolvedValue(true);
		const kp = new CacheKeepalive({ timer, gates: createGates(), ping });

		kp.scheduleIdle();
		kp.scheduleIdle();
		kp.scheduleIdle();

		expect(timer.pendingCount()).toBe(1);
	});

	// isEnabled is deliberately excluded here: scheduleIdle() also gates on it
	// (so a kill-switch flipped OFF from the start never even arms a timer) —
	// that path has its own dedicated test above. This table covers the other
	// four gates, each re-checked live at fire time.
	const gateCases: Array<[string, Partial<CacheKeepaliveGates>]> = [
		["isEligibleModel", { isEligibleModel: () => false }],
		["isIdle", { isIdle: () => false }],
		["hasLargeEnoughPrefix", { hasLargeEnoughPrefix: () => false }],
		["isCompactionInFlight", { isCompactionInFlight: () => true }],
	];

	it.each(gateCases)("does not ping when gate %s fails at fire time", async (_name, override) => {
		const timer = createFakeTimer();
		const ping = vi.fn().mockResolvedValue(true);
		const kp = new CacheKeepalive({ timer, gates: createGates(override), ping });

		kp.scheduleIdle();
		timer.fireLatest();
		await flush();

		expect(ping).not.toHaveBeenCalled();
		// A blocked gate ends the idle period quietly — no retry timer left armed.
		expect(timer.pendingCount()).toBe(0);
	});

	it("re-checks gates at fire time, not just at schedule time", async () => {
		const timer = createFakeTimer();
		const ping = vi.fn().mockResolvedValue(true);
		let idle = true;
		const kp = new CacheKeepalive({ timer, gates: createGates({ isIdle: () => idle }), ping });

		kp.scheduleIdle(); // armed while idle
		idle = false; // session started streaming again before the timer fired
		timer.fireLatest();
		await flush();

		expect(ping).not.toHaveBeenCalled();
	});

	it("re-checks the kill-switch at fire time too (armed while on, flipped off before it fires)", async () => {
		const timer = createFakeTimer();
		const ping = vi.fn().mockResolvedValue(true);
		let enabled = true;
		const kp = new CacheKeepalive({ timer, gates: createGates({ isEnabled: () => enabled }), ping });

		kp.scheduleIdle(); // armed while PIT_NO_CACHE_KEEPALIVE is unset
		enabled = false; // killed mid-idle-wait
		timer.fireLatest();
		await flush();

		expect(ping).not.toHaveBeenCalled();
	});

	it("pings successfully, reschedules, and stops after the 2-ping-per-idle-period cap", async () => {
		const timer = createFakeTimer();
		const ping = vi.fn().mockResolvedValue(true);
		const kp = new CacheKeepalive({ timer, gates: createGates(), ping });

		kp.scheduleIdle();
		timer.fireLatest(); // ping #1
		await flush();
		expect(ping).toHaveBeenCalledTimes(1);
		expect(timer.pendingCount()).toBe(1); // reschedules automatically on success

		timer.fireLatest(); // ping #2
		await flush();
		expect(ping).toHaveBeenCalledTimes(2);
		expect(timer.pendingCount()).toBe(0); // cap reached, no third timer

		// Even an explicit external scheduleIdle() call refuses once the cap is hit.
		kp.scheduleIdle();
		expect(timer.pendingCount()).toBe(0);
		expect(ping).toHaveBeenCalledTimes(2);
	});

	it("does not reschedule after a failed ping", async () => {
		const timer = createFakeTimer();
		const ping = vi.fn().mockResolvedValue(false);
		const kp = new CacheKeepalive({ timer, gates: createGates(), ping });

		kp.scheduleIdle();
		timer.fireLatest();
		await flush();

		expect(ping).toHaveBeenCalledTimes(1);
		expect(timer.pendingCount()).toBe(0);
	});

	it("onActivity() cancels the pending timer and resets the ping budget for the next idle period", async () => {
		const timer = createFakeTimer();
		const ping = vi.fn().mockResolvedValue(true);
		const kp = new CacheKeepalive({ timer, gates: createGates(), ping });

		kp.scheduleIdle();
		expect(timer.pendingCount()).toBe(1);

		kp.onActivity();
		expect(timer.clearTimer).toHaveBeenCalledTimes(1);
		expect(timer.pendingCount()).toBe(0);

		// Exhaust the 2-ping cap for a full idle period.
		kp.scheduleIdle();
		timer.fireLatest();
		await flush();
		timer.fireLatest();
		await flush();
		expect(ping).toHaveBeenCalledTimes(2);
		expect(timer.pendingCount()).toBe(0);

		// New activity resets the budget: a fresh idle period can ping again.
		kp.onActivity();
		kp.scheduleIdle();
		expect(timer.pendingCount()).toBe(1);
		timer.fireLatest();
		await flush();
		expect(ping).toHaveBeenCalledTimes(3);
	});

	it("does not resurrect a reschedule when onActivity() fires while a ping is in flight", async () => {
		const timer = createFakeTimer();
		let resolvePing: ((ok: boolean) => void) | undefined;
		const ping = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					resolvePing = resolve;
				}),
		);
		const kp = new CacheKeepalive({ timer, gates: createGates(), ping });

		kp.scheduleIdle();
		timer.fireLatest(); // starts the in-flight ping
		await Promise.resolve(); // let fire() reach `await this.deps.ping()`
		expect(ping).toHaveBeenCalledTimes(1);

		kp.onActivity(); // user sends a new prompt mid-ping
		resolvePing?.(true); // the stale ping resolves successfully afterwards
		await flush();

		// The user's new turn already re-armed nothing (onActivity only cancels);
		// the stale in-flight ping's success must not sneak in a reschedule.
		expect(timer.pendingCount()).toBe(0);
	});
});

describe("modelHasShortCacheRetention", () => {
	const baseModel = { id: "claude-test", provider: "anthropic" } as unknown as Model<any>;

	it("is false (long retention, the default) when compat is unset", () => {
		expect(modelHasShortCacheRetention(baseModel)).toBe(false);
	});

	it("is false when compat explicitly enables long retention", () => {
		const model = { ...baseModel, compat: { supportsLongCacheRetention: true } } as unknown as Model<any>;
		expect(modelHasShortCacheRetention(model)).toBe(false);
	});

	it("is true only when compat explicitly disables long retention", () => {
		const model = { ...baseModel, compat: { supportsLongCacheRetention: false } } as unknown as Model<any>;
		expect(modelHasShortCacheRetention(model)).toBe(true);
	});
});
