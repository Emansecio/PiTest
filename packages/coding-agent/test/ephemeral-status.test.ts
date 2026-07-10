import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EPHEMERAL_INFO_TTL_MS,
	EPHEMERAL_WARNING_TTL_MS,
	EphemeralStatusController,
} from "../src/modes/interactive/ephemeral-status.ts";

describe("EphemeralStatusController", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("paints info and auto-dismisses after TTL", () => {
		vi.useFakeTimers();
		const paints: Array<{ message: string; kind: string }> = [];
		let clears = 0;
		const c = new EphemeralStatusController({
			paint: (message, kind) => paints.push({ message, kind }),
			clear: () => {
				clears++;
			},
		});
		c.show("hello", "info");
		expect(paints).toEqual([{ message: "hello", kind: "info" }]);
		expect(c.isActive()).toBe(true);
		vi.advanceTimersByTime(EPHEMERAL_INFO_TTL_MS - 1);
		expect(clears).toBe(0);
		vi.advanceTimersByTime(1);
		expect(clears).toBe(1);
		expect(c.isActive()).toBe(false);
	});

	it("keeps errors sticky until clear()", () => {
		vi.useFakeTimers();
		let clears = 0;
		const c = new EphemeralStatusController({
			paint: () => {},
			clear: () => {
				clears++;
			},
		});
		c.show("boom", "error");
		vi.advanceTimersByTime(60_000);
		expect(clears).toBe(0);
		expect(c.isActive()).toBe(true);
		c.clear();
		expect(clears).toBe(1);
		expect(c.isActive()).toBe(false);
	});

	it("warning uses longer TTL than info", () => {
		vi.useFakeTimers();
		let clears = 0;
		const c = new EphemeralStatusController({
			paint: () => {},
			clear: () => {
				clears++;
			},
		});
		c.show("careful", "warning");
		vi.advanceTimersByTime(EPHEMERAL_INFO_TTL_MS);
		expect(clears).toBe(0);
		vi.advanceTimersByTime(EPHEMERAL_WARNING_TTL_MS - EPHEMERAL_INFO_TTL_MS);
		expect(clears).toBe(1);
	});

	it("replacing a toast cancels the previous timer", () => {
		vi.useFakeTimers();
		const paints: string[] = [];
		let clears = 0;
		const c = new EphemeralStatusController({
			paint: (message) => paints.push(message),
			clear: () => {
				clears++;
			},
		});
		c.show("first", "info");
		vi.advanceTimersByTime(1000);
		c.show("second", "info");
		expect(paints).toEqual(["first", "second"]);
		vi.advanceTimersByTime(EPHEMERAL_INFO_TTL_MS - 1);
		expect(clears).toBe(0);
		vi.advanceTimersByTime(1);
		expect(clears).toBe(1);
	});
});
