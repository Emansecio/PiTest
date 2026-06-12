import { describe, expect, it } from "vitest";
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
