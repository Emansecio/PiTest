import { describe, expect, test, vi } from "vitest";
import {
	DEFAULT_EXTENSION_DIALOG_TIMEOUT_MS,
	resolveDialogTimeoutMs,
	settlePendingDialogs,
} from "../src/modes/rpc/rpc-mode.js";

describe("resolveDialogTimeoutMs — extension dialog backstop ceiling", () => {
	test("no opts at all → default ceiling (dialog can never wait forever)", () => {
		expect(resolveDialogTimeoutMs(undefined)).toBe(DEFAULT_EXTENSION_DIALOG_TIMEOUT_MS);
		expect(resolveDialogTimeoutMs({})).toBe(DEFAULT_EXTENSION_DIALOG_TIMEOUT_MS);
	});

	test("explicit timeout always wins", () => {
		expect(resolveDialogTimeoutMs({ timeout: 1234 })).toBe(1234);
	});

	test("a caller-supplied signal opts out of the ceiling", () => {
		const controller = new AbortController();
		expect(resolveDialogTimeoutMs({ signal: controller.signal })).toBeUndefined();
	});

	test("explicit timeout still wins even alongside a signal", () => {
		const controller = new AbortController();
		expect(resolveDialogTimeoutMs({ timeout: 500, signal: controller.signal })).toBe(500);
	});

	test("the ceiling is a generous few-minutes backstop, not a tight deadline", () => {
		expect(DEFAULT_EXTENSION_DIALOG_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
	});
});

describe("settlePendingDialogs — shutdown sweep", () => {
	test("cancels every pending dialog and empties the map", () => {
		const a = { cancel: vi.fn() };
		const b = { cancel: vi.fn() };
		const map = new Map([
			["a", a],
			["b", b],
		]);

		settlePendingDialogs(map);

		expect(a.cancel).toHaveBeenCalledTimes(1);
		expect(b.cancel).toHaveBeenCalledTimes(1);
		expect(map.size).toBe(0);
	});

	test("is safe when cancel() mutates the map during the sweep (snapshot first)", () => {
		const map = new Map<string, { cancel: () => void }>();
		const a = { cancel: vi.fn(() => map.delete("a")) };
		const b = { cancel: vi.fn(() => map.delete("b")) };
		map.set("a", a);
		map.set("b", b);

		expect(() => settlePendingDialogs(map)).not.toThrow();
		expect(a.cancel).toHaveBeenCalledTimes(1);
		expect(b.cancel).toHaveBeenCalledTimes(1);
		expect(map.size).toBe(0);
	});
});
