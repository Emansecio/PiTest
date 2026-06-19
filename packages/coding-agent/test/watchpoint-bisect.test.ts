import { describe, expect, it } from "vitest";
import type {
	DapContinueOutcome,
	DapDataBreakpointInfoResponse,
	DapEvaluateResponse,
	DapSessionSummary,
	DapStackFrame,
} from "../src/core/dap/types.js";
import {
	formatWatchpointBisect,
	runWatchpointBisect,
	type WatchpointBisectDeps,
} from "../src/core/watchpoint-bisect.js";

// --- minimal valid DapSessionSummary for snapshots returned by mocked deps ---
function summary(over: Partial<DapSessionSummary> = {}): DapSessionSummary {
	return {
		id: "s1",
		adapter: "lldb-dap",
		cwd: "C:/proj",
		status: "stopped",
		launchedAt: "now",
		lastUsedAt: "now",
		breakpointFiles: 0,
		breakpointCount: 0,
		functionBreakpointCount: 0,
		outputBytes: 0,
		outputTruncated: false,
		needsConfigurationDone: false,
		...over,
	};
}

function frame(id: number, name: string, file: string, line: number): DapStackFrame {
	return { id, name, line, column: 1, source: { path: file, name: file } };
}

function stoppedOutcome(reason: string): DapContinueOutcome {
	return { snapshot: summary({ stopReason: reason }), state: "stopped", timedOut: false };
}

function terminatedOutcome(): DapContinueOutcome {
	return { snapshot: summary({ status: "terminated" }), state: "terminated", timedOut: false };
}

/**
 * Builds a deps object that simulates a write watchpoint stopping at a scripted
 * sequence of stacks. Records what was armed so the test can assert the wiring.
 */
function makeDeps(opts: {
	supports: boolean;
	dataId?: string | null;
	accessTypes?: Array<"read" | "write" | "readWrite">;
	stops: DapStackFrame[][]; // one stack per stop; loop ends when this runs out
	values?: string[]; // value returned by evaluate at each stop (parallel to stops)
	withSetters?: boolean;
	references?: Array<{ file: string; line: number; column?: number }>;
}) {
	const calls = {
		setData: [] as Array<{ dataId: string; accessType?: string }>,
		setBreakpoint: [] as Array<{ file: string; line: number }>,
		setFunctionBreakpoint: [] as string[],
		continueCount: 0,
		evaluateExprs: [] as string[],
		evaluateFrames: [] as Array<number | undefined>,
		referencesQueried: 0,
	};

	let stopIndex = 0;

	const deps: WatchpointBisectDeps = {
		supportsDataBreakpoints: () => opts.supports,
		dataBreakpointInfo: async (
			_name,
		): Promise<{ snapshot: DapSessionSummary; info: DapDataBreakpointInfoResponse }> => ({
			snapshot: summary(),
			info: {
				dataId: opts.dataId === undefined ? "data-1" : opts.dataId,
				description: opts.dataId === null ? "not watchable" : "ok",
				accessTypes: opts.accessTypes,
			},
		}),
		setDataBreakpoint: async (dataId, accessType) => {
			calls.setData.push({ dataId, accessType });
			return { snapshot: summary(), breakpoints: [] };
		},
		continue: async (): Promise<DapContinueOutcome> => {
			const idx = stopIndex;
			calls.continueCount++;
			if (idx >= opts.stops.length) {
				// no more scripted stops → program runs to completion
				return terminatedOutcome();
			}
			stopIndex++;
			return stoppedOutcome(`watch-hit-${idx}`);
		},
		stackTrace: async (): Promise<{
			snapshot: DapSessionSummary;
			stackFrames: DapStackFrame[];
			totalFrames?: number;
		}> => {
			// stackTrace is called AFTER continue advanced stopIndex, so the relevant
			// stack is the one we just stopped on (stopIndex - 1).
			const stack = opts.stops[stopIndex - 1] ?? [];
			return { snapshot: summary(), stackFrames: stack };
		},
		scopes: async () => ({ snapshot: summary(), scopes: [] }),
		evaluate: async (
			expression,
			_context,
			frameId,
		): Promise<{ snapshot: DapSessionSummary; evaluation: DapEvaluateResponse }> => {
			calls.evaluateExprs.push(expression);
			calls.evaluateFrames.push(frameId);
			const v = opts.values?.[stopIndex - 1];
			return {
				snapshot: summary(),
				evaluation: { result: v ?? "<n/a>", variablesReference: 0 },
			};
		},
	};

	if (opts.withSetters) {
		deps.setBreakpoint = async (file, line) => {
			calls.setBreakpoint.push({ file, line });
			return { snapshot: summary(), sourcePath: file, breakpoints: [] };
		};
		deps.setFunctionBreakpoint = async (name) => {
			calls.setFunctionBreakpoint.push(name);
			return { snapshot: summary(), breakpoints: [] };
		};
	}

	if (opts.references) {
		deps.findReferences = async () => {
			calls.referencesQueried++;
			return opts.references as Array<{ file: string; line: number; column?: number }>;
		};
	}

	return { deps, calls };
}

describe("runWatchpointBisect — data breakpoint path", () => {
	it("captures two distinct writers in order with their values", async () => {
		const { deps, calls } = makeDeps({
			supports: true,
			stops: [[frame(10, "corruptA", "C:/proj/a.c", 42)], [frame(20, "corruptB", "C:/proj/b.c", 7)]],
			values: ["0xdead", "0xbeef"],
		});

		const result = await runWatchpointBisect(deps, { expression: "counter", maxHits: 8 });

		expect(result.mode).toBe("data-breakpoint");
		expect(result.dataId).toBe("data-1");
		// armed a WRITE watchpoint
		expect(calls.setData).toEqual([{ dataId: "data-1", accessType: "write" }]);

		// both writers captured, top-of-stack each
		expect(result.hits).toHaveLength(2);
		expect(result.writer).toEqual(expect.objectContaining({ function: "corruptA", file: "C:/proj/a.c", line: 42 }));
		expect(result.value).toBe("0xdead");
		expect(result.hits[1].writer).toEqual(
			expect.objectContaining({ function: "corruptB", file: "C:/proj/b.c", line: 7 }),
		);
		expect(result.hits[1].value).toBe("0xbeef");

		// value was read at the WRITER's frame, not a stale/default frame
		expect(calls.evaluateFrames).toEqual([10, 20]);
		expect(result.cappedOut).toBe(false);

		// loop stops on its own once the program terminates: 2 stops + 1 terminating continue
		expect(calls.continueCount).toBe(3);
	});

	it("respects the hit-cap and reports cappedOut (no infinite continue loop)", async () => {
		// program writes forever — stop every iteration
		const manyStops: DapStackFrame[][] = Array.from({ length: 100 }, (_, i) => [
			frame(100 + i, "hotLoopWriter", "C:/proj/loop.c", 5),
		]);
		const { deps, calls } = makeDeps({ supports: true, stops: manyStops });

		const result = await runWatchpointBisect(deps, { expression: "x", maxHits: 3 });

		expect(result.hits).toHaveLength(3);
		expect(result.cappedOut).toBe(true);
		// exactly maxHits continues — never ran past the cap
		expect(calls.continueCount).toBe(3);
	});

	it("a stop with no stack frames records a hit with no frame, without crashing (#30)", async () => {
		// Adapter stops but returns an empty stack: writerFromStack yields no writer.
		const { deps } = makeDeps({ supports: true, stops: [[]] });
		const result = await runWatchpointBisect(deps, { expression: "x", maxHits: 8 });
		expect(result.hits).toHaveLength(1);
		const hit = result.hits[0];
		// `frame` must be undefined (not a non-null-cast lie); guard-safe for consumers.
		expect(hit.writer.frame).toBeUndefined();
		expect(hit.writer.function).toBe("<unknown>");
		// A consumer that guards the optional frame must not throw.
		expect(() => hit.writer.frame?.id).not.toThrow();
		// formatWatchpointBisect tolerates the frame-less hit.
		expect(() => formatWatchpointBisect(result)).not.toThrow();
	});

	it("downgrades access type when the adapter doesn't support write-only", async () => {
		const { deps, calls } = makeDeps({
			supports: true,
			accessTypes: ["readWrite"],
			stops: [[frame(1, "w", "C:/proj/x.c", 1)]],
		});

		const result = await runWatchpointBisect(deps, { expression: "v", accessType: "write" });

		expect(calls.setData[0].accessType).toBe("readWrite");
		expect(result.note).toContain("readWrite");
	});
});

describe("runWatchpointBisect — conditional breakpoint fallback", () => {
	it("uses a function breakpoint when hardware watchpoints are unavailable", async () => {
		const { deps, calls } = makeDeps({
			supports: false,
			withSetters: true,
			stops: [[frame(5, "writeViaFn", "C:/proj/c.c", 99)]],
		});

		const result = await runWatchpointBisect(deps, {
			expression: "buf",
			fallbackFunction: "writeBuffer",
		});

		expect(result.mode).toBe("conditional-breakpoint");
		// did NOT touch the data-breakpoint path
		expect(calls.setData).toHaveLength(0);
		// planted the conditional function breakpoint
		expect(calls.setFunctionBreakpoint).toEqual(["writeBuffer"]);
		expect(result.writer).toEqual(expect.objectContaining({ function: "writeViaFn", file: "C:/proj/c.c", line: 99 }));
		expect(result.note).toContain("conditional breakpoint fallback");
	});

	it("uses a file:line breakpoint fallback", async () => {
		const { deps, calls } = makeDeps({
			supports: false,
			withSetters: true,
			stops: [[frame(8, "lineWriter", "C:/proj/d.c", 12)]],
		});

		const result = await runWatchpointBisect(deps, {
			expression: "g",
			fallbackFile: "C:/proj/d.c",
			fallbackLine: 12,
		});

		expect(result.mode).toBe("conditional-breakpoint");
		expect(calls.setBreakpoint).toEqual([{ file: "C:/proj/d.c", line: 12 }]);
		expect(result.writer?.function).toBe("lineWriter");
	});

	it("falls back when the adapter cannot resolve a dataId, surfacing a note", async () => {
		const { deps, calls } = makeDeps({
			supports: true,
			dataId: null, // adapter advertises data bps but can't watch this symbol
			withSetters: true,
			stops: [[frame(3, "fnWriter", "C:/proj/e.c", 4)]],
		});

		const result = await runWatchpointBisect(deps, {
			expression: "weird",
			fallbackFunction: "writer",
		});

		expect(result.mode).toBe("conditional-breakpoint");
		expect(calls.setData).toHaveLength(0);
		expect(calls.setFunctionBreakpoint).toEqual(["writer"]);
		expect(result.note).toContain("could not resolve a watchpoint");
	});

	it("returns a structured guidance result (no throw) when no fallback target is given", async () => {
		const { deps, calls } = makeDeps({
			supports: false,
			withSetters: true,
			stops: [],
			references: [{ file: "C:/proj/f.c", line: 3 }],
		});

		const result = await runWatchpointBisect(deps, {
			expression: "sym",
			crossReference: true,
		});

		expect(result.mode).toBe("conditional-breakpoint");
		expect(result.hits).toHaveLength(0);
		// did not plant anything
		expect(calls.setBreakpoint).toHaveLength(0);
		expect(calls.setFunctionBreakpoint).toHaveLength(0);
		expect(result.note).toContain("no fallback target");
		// references were collected and surfaced for the model to pick a line
		expect(result.references).toEqual([{ file: "C:/proj/f.c", line: 3 }]);
	});
});

describe("runWatchpointBisect — LSP cross-reference", () => {
	it("attaches static writer references and tolerates a throwing findReferences", async () => {
		const { deps } = makeDeps({
			supports: true,
			stops: [[frame(1, "w", "C:/proj/x.c", 1)]],
			references: [
				{ file: "C:/proj/x.c", line: 1 },
				{ file: "C:/proj/y.c", line: 9 },
			],
		});

		const result = await runWatchpointBisect(deps, { expression: "z", crossReference: true });
		expect(result.references).toHaveLength(2);

		// throwing findReferences must not abort the bisect (fresh deps — the loop above
		// already consumed the single scripted stop in `deps`).
		const { deps: deps2 } = makeDeps({
			supports: true,
			stops: [[frame(1, "w", "C:/proj/x.c", 1)]],
			references: [{ file: "C:/proj/x.c", line: 1 }],
		});
		deps2.findReferences = async () => {
			throw new Error("lsp down");
		};
		const result2 = await runWatchpointBisect(deps2, { expression: "z", crossReference: true });
		expect(result2.references).toEqual([]);
		expect(result2.writer).toBeDefined();
	});
});

describe("formatWatchpointBisect", () => {
	it("renders writer, extra hits and references", () => {
		const text = formatWatchpointBisect({
			mode: "data-breakpoint",
			writer: { file: "a.c", line: 1, function: "f", frame: frame(1, "f", "a.c", 1) },
			value: "42",
			hits: [
				{ writer: { file: "a.c", line: 1, function: "f", frame: frame(1, "f", "a.c", 1) }, value: "42", stack: [] },
				{ writer: { file: "b.c", line: 2, function: "g", frame: frame(2, "g", "b.c", 2) }, value: "43", stack: [] },
			],
			references: [{ file: "a.c", line: 1 }],
			cappedOut: true,
		});
		expect(text).toContain("f @ a.c:1");
		expect(text).toContain("+1: g @ b.c:2");
		expect(text).toContain("Static writers");
		expect(text).toContain("hit-cap reached");
	});
});
