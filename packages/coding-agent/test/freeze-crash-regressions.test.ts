/**
 * Regression tests for freeze/crash mitigations (C1–C3, H1, H6, M1).
 * See audit: terminal hang, abrupt process death, orphan children.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withTuiSignalGuard } from "../src/cli/with-tui-signal-guard.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner, emitSessionShutdownEvent } from "../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createAskToolDefinition } from "../src/core/tools/ask.ts";
import {
	_registerBashBackgroundJobForTest,
	_resetBashBackgroundJobsForTest,
	disposeBashBackgroundJobs,
	listBashBackgroundJobs,
} from "../src/core/tools/bash.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import type { UserInputBus } from "../src/core/user-input-bus.ts";

// ---------------------------------------------------------------------------
// C2: finished OutputAccumulator must not throw on late append
// ---------------------------------------------------------------------------

describe("C2: OutputAccumulator late append after finish", () => {
	it("no-ops instead of throwing when append is called after finish", () => {
		const acc = new OutputAccumulator({ maxLines: 100, maxBytes: 10_000 });
		acc.append(Buffer.from("hello\n"));
		acc.finish();
		expect(() => acc.append(Buffer.from("late chunk that would kill the process\n"))).not.toThrow();
		const snap = acc.snapshot();
		expect(snap.content).toContain("hello");
		expect(snap.content).not.toContain("late chunk");
	});
});

// ---------------------------------------------------------------------------
// C1 / H6: disposeBashBackgroundJobs clears registry and kills jobs
// ---------------------------------------------------------------------------

describe("C1/H6: disposeBashBackgroundJobs", () => {
	beforeEach(() => {
		_resetBashBackgroundJobsForTest();
	});
	afterEach(() => {
		_resetBashBackgroundJobsForTest();
	});

	it("kills running jobs and empties the registry", () => {
		const kills: string[] = [];
		_registerBashBackgroundJobForTest({
			id: "bg-1",
			pid: undefined,
			command: "sleep 999",
			startedAt: Date.now(),
			promotedAt: Date.now(),
			exited: false,
			exitCode: null,
			ringBuffer: "",
			ringTruncated: false,
			kill: () => {
				kills.push("bg-1");
			},
		});
		_registerBashBackgroundJobForTest({
			id: "bg-2",
			pid: undefined,
			command: "done",
			startedAt: Date.now(),
			promotedAt: Date.now(),
			exited: true,
			exitCode: 0,
			ringBuffer: "",
			ringTruncated: false,
			kill: () => {
				kills.push("bg-2");
			},
		});
		expect(listBashBackgroundJobs()).toHaveLength(2);
		disposeBashBackgroundJobs();
		expect(listBashBackgroundJobs()).toHaveLength(0);
		// Only non-exited jobs are kill()'d
		expect(kills).toEqual(["bg-1"]);
	});
});

// ---------------------------------------------------------------------------
// H1: ask tool aborts when signal fires
// ---------------------------------------------------------------------------

describe("H1: ask tool abort signal", () => {
	it("returns cancelled when signal is already aborted", async () => {
		const bus: UserInputBus = {
			async askOptions() {
				throw new Error("should not be called when pre-aborted");
			},
			onRequest() {
				return () => {};
			},
			resolve() {},
			cancelAll() {},
			hasListener() {
				return true;
			},
		};
		const def = createAskToolDefinition("/tmp", { bus });
		const ac = new AbortController();
		ac.abort();
		const res = await (def.execute as (...args: unknown[]) => Promise<any>)(
			"call",
			{ question: "Q?", options: [{ label: "A" }] },
			ac.signal,
		);
		expect(res.details?.cancelled).toBe(true);
		const text = res.content.find((c: { type: string }) => c.type === "text");
		expect(text && "text" in text ? text.text : "").toContain("cancelled");
	});

	it("cancels a pending ask when signal aborts mid-wait", async () => {
		let cancelAllCalls = 0;
		const bus: UserInputBus = {
			async askOptions() {
				// Park forever until cancelAll / abort
				return new Promise(() => {});
			},
			onRequest() {
				return () => {};
			},
			resolve() {},
			cancelAll() {
				cancelAllCalls += 1;
			},
			hasListener() {
				return true;
			},
		};
		const def = createAskToolDefinition("/tmp", { bus });
		const ac = new AbortController();
		const pending = (def.execute as (...args: unknown[]) => Promise<any>)(
			"call",
			{ question: "Q?", options: [{ label: "A" }] },
			ac.signal,
		);
		// Let the promise park on askOptions
		await new Promise((r) => setTimeout(r, 20));
		ac.abort();
		const res = await pending;
		expect(res.details?.cancelled).toBe(true);
		expect(cancelAllCalls).toBeGreaterThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// C3: session_shutdown emit timeout
// ---------------------------------------------------------------------------

describe("C3: session_shutdown timeout", () => {
	let tempDir: string;
	const prev = process.env.PIT_SESSION_SHUTDOWN_TIMEOUT_MS;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shutdown-to-"));
		process.env.PIT_SESSION_SHUTDOWN_TIMEOUT_MS = "80";
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		if (prev === undefined) delete process.env.PIT_SESSION_SHUTDOWN_TIMEOUT_MS;
		else process.env.PIT_SESSION_SHUTDOWN_TIMEOUT_MS = prev;
	});

	it("returns without hanging when a session_shutdown handler never settles", async () => {
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage);
		const eventBus = createEventBus();
		const runtime = createExtensionRuntime();

		const factory: ExtensionFactory = (pi) => {
			pi.on("session_shutdown", async () => {
				await new Promise(() => {}); // never settles
			});
		};
		const extension = await loadExtensionFromFactory(factory, tempDir, eventBus, runtime, "hang-shutdown://test");
		const runner = new ExtensionRunner([extension], runtime, tempDir, sessionManager, modelRegistry);

		const start = Date.now();
		const emitted = await emitSessionShutdownEvent(runner, { type: "session_shutdown", reason: "new" });
		expect(emitted).toBe(true);
		expect(Date.now() - start).toBeLessThan(2000);
	});
});

// ---------------------------------------------------------------------------
// M1 / pre-interactive: withTuiSignalGuard must not leave run() hanging
// ---------------------------------------------------------------------------

describe("M1: withTuiSignalGuard unhandledRejection", () => {
	it("rejects the guarded run when an unhandled rejection fires mid-run", async () => {
		const stops: number[] = [];
		const ui = {
			stop() {
				stops.push(1);
			},
		};
		// Node may also emit a warning for the intentional unhandled rejection;
		// the guard must still surface it and restore the TUI.
		const result = withTuiSignalGuard(ui, async () => {
			queueMicrotask(() => {
				void Promise.reject(new Error("picker boom"));
			});
			await new Promise(() => {}); // hang until rejection aborts the guard
			return "never";
		});

		await expect(result).rejects.toThrow(/picker boom/i);
		expect(stops.length).toBeGreaterThanOrEqual(1);
	});
});
