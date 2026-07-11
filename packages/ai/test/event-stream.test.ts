import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventStream } from "../src/utils/event-stream.js";

// A tiny event shape with an optional completion marker so we can drive
// isComplete/extractResult without pulling in the AssistantMessage types.
type Ev = { n: number; complete?: boolean; result?: string };

function makeStream() {
	return new EventStream<Ev, string>(
		(e) => e.complete === true,
		(e) => e.result ?? "",
	);
}

describe("EventStream cursor dequeue", () => {
	it("(1) drains a 3000-event burst in exact order, crossing the compaction threshold", async () => {
		const s = makeStream();
		const N = 3000; // > 1024 so the splice/compaction path runs (twice)
		for (let i = 0; i < N; i++) {
			s.push({ n: i });
		}
		s.end();

		const seen: number[] = [];
		for await (const e of s) {
			seen.push(e.n);
		}

		expect(seen.length).toBe(N);
		expect(seen[0]).toBe(0);
		expect(seen[N - 1]).toBe(N - 1);
		// strict ordering, no gaps/dupes
		for (let i = 0; i < N; i++) {
			expect(seen[i]).toBe(i);
		}
	});

	it("(1b) interleaving push during consumption keeps order across compaction", async () => {
		const s = makeStream();
		const N = 5000;
		const seen: number[] = [];

		const consumer = (async () => {
			for await (const e of s) {
				seen.push(e.n);
			}
		})();

		// Push in chunks, yielding to the event loop so the consumer reenters
		// the generator between bursts (exercising splice while suspended).
		for (let i = 0; i < N; i++) {
			s.push({ n: i });
			if (i % 250 === 0) {
				await Promise.resolve();
			}
		}
		s.end();
		await consumer;

		expect(seen.length).toBe(N);
		for (let i = 0; i < N; i++) {
			expect(seen[i]).toBe(i);
		}
	});

	it("(2) a waiting consumer receives a direct push (waiter path)", async () => {
		const s = makeStream();
		const it = s[Symbol.asyncIterator]();

		// Start awaiting before anything is queued -> registers a waiter.
		const pending = it.next();
		await Promise.resolve();
		s.push({ n: 42 });

		const r = await pending;
		expect(r.done).toBe(false);
		expect(r.value).toEqual({ n: 42 });
	});

	it("(3) push after done is ignored", async () => {
		const s = makeStream();
		s.push({ n: 1 });
		s.end();
		s.push({ n: 2 }); // should be dropped

		const seen: number[] = [];
		for await (const e of s) {
			seen.push(e.n);
		}
		expect(seen).toEqual([1]);
	});

	it("(4) end() with consumers waiting terminates the iteration", async () => {
		const s = makeStream();
		const seen: number[] = [];

		const consumer = (async () => {
			for await (const e of s) {
				seen.push(e.n);
			}
			return "ended";
		})();

		await Promise.resolve(); // consumer parks as a waiter
		s.end();

		await expect(consumer).resolves.toBe("ended");
		expect(seen).toEqual([]);
	});

	it("(4b) multiple waiters are all released by end()", async () => {
		const s = makeStream();
		const a = s[Symbol.asyncIterator]();
		const b = s[Symbol.asyncIterator]();
		const pa = a.next();
		const pb = b.next();
		await Promise.resolve();
		s.end();

		const [ra, rb] = await Promise.all([pa, pb]);
		expect(ra.done).toBe(true);
		expect(rb.done).toBe(true);
	});

	it("(5) result() resolves with the completion event's extracted result", async () => {
		const s = makeStream();
		s.push({ n: 1 });
		s.push({ n: 2, complete: true, result: "final" });

		await expect(s.result()).resolves.toBe("final");

		// The completion event is still delivered through the stream.
		const seen: Ev[] = [];
		for await (const e of s) {
			seen.push(e);
		}
		expect(seen.map((e) => e.n)).toEqual([1, 2]);
	});
});

describe("EventStream backlog observability guard", () => {
	const prevWarn = process.env.PIT_EVENT_STREAM_WARN_DEPTH;
	const prevMax = process.env.PIT_EVENT_STREAM_MAX_DEPTH;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		// Default hard max would trip the warn-depth tests that buffer 25–1000 events.
		process.env.PIT_EVENT_STREAM_MAX_DEPTH = "0";
	});
	afterEach(() => {
		warnSpy.mockRestore();
		if (prevWarn === undefined) {
			delete process.env.PIT_EVENT_STREAM_WARN_DEPTH;
		} else {
			process.env.PIT_EVENT_STREAM_WARN_DEPTH = prevWarn;
		}
		if (prevMax === undefined) {
			delete process.env.PIT_EVENT_STREAM_MAX_DEPTH;
		} else {
			process.env.PIT_EVENT_STREAM_MAX_DEPTH = prevMax;
		}
	});

	it("(6) warns exactly once when the unconsumed backlog crosses the threshold", () => {
		process.env.PIT_EVENT_STREAM_WARN_DEPTH = "10";
		const s = makeStream(); // threshold resolved at construction
		// Nobody consumes -> every push queues. Crossing depth 10 trips the guard.
		for (let i = 0; i < 25; i++) {
			s.push({ n: i });
		}
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(String(warnSpy.mock.calls[0]?.[0])).toContain("backlog");

		// Events are buffered, not dropped: the full burst still drains in order.
		const seen: number[] = [];
		const drain = (async () => {
			for await (const e of s) seen.push(e.n);
		})();
		s.end();
		return drain.then(() => {
			expect(seen.length).toBe(25);
			expect(seen[0]).toBe(0);
			expect(seen[24]).toBe(24);
		});
	});

	it("(7) does not warn below the threshold", () => {
		process.env.PIT_EVENT_STREAM_WARN_DEPTH = "10000";
		const s = makeStream();
		for (let i = 0; i < 100; i++) {
			s.push({ n: i });
		}
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("(8) a value <= 0 disables the guard entirely", () => {
		process.env.PIT_EVENT_STREAM_WARN_DEPTH = "0";
		const s = makeStream();
		for (let i = 0; i < 1000; i++) {
			s.push({ n: i });
		}
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("(8b) hard max throws once the unconsumed backlog crosses the ceiling", () => {
		process.env.PIT_EVENT_STREAM_WARN_DEPTH = "0";
		process.env.PIT_EVENT_STREAM_MAX_DEPTH = "10";
		const s = makeStream();
		for (let i = 0; i < 9; i++) {
			s.push({ n: i });
		}
		expect(() => s.push({ n: 9 })).toThrow(/backlog exceeded 10/);
	});

	it("(9) a keeping-up consumer (waiter present) never trips the guard", async () => {
		process.env.PIT_EVENT_STREAM_WARN_DEPTH = "5";
		const s = makeStream();
		const it = s[Symbol.asyncIterator]();
		const seen: number[] = [];

		// Lock-step: park a waiter, then push. The event lands on the waiter
		// (depth stays 0), so a keeping-up consumer never buffers a backlog.
		for (let i = 0; i < 50; i++) {
			const pending = it.next();
			await Promise.resolve(); // let it.next() register the waiter
			s.push({ n: i });
			const r = await pending;
			if (!r.done) seen.push(r.value.n);
		}

		expect(seen.length).toBe(50);
		expect(warnSpy).not.toHaveBeenCalled();
	});
});
