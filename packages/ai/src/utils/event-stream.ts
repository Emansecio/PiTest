import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";
import { recordDiagnostic } from "./runtime-diagnostics.ts";

// Pathological backlog threshold for the observability guard below. The producer
// (provider SSE loop) is network-paced and the consumer (agent-loop) drains at
// microtask speed with no blocking I/O between events, so the live backlog
// normally stays tiny. Real backpressure (async push) is an invasive follow-up:
// it would change push()'s signature and require awaiting at ~80 provider
// call-sites. Until then, warn once if depth ever crosses this watermark so a
// slow-consumer regression is detectable in production without changing
// semantics. Override via PIT_EVENT_STREAM_WARN_DEPTH (<=0 disables).
const DEFAULT_BACKLOG_WARN_DEPTH = 50000;
// Hard ceiling: once crossed, push() throws so the producer fails into its
// error path instead of buffering without bound. Override via
// PIT_EVENT_STREAM_MAX_DEPTH (<=0 disables the hard cap).
const DEFAULT_BACKLOG_HARD_MAX = 100000;

function resolveBacklogWarnDepth(): number {
	const raw = process.env.PIT_EVENT_STREAM_WARN_DEPTH;
	if (raw === undefined) return DEFAULT_BACKLOG_WARN_DEPTH;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed)) return DEFAULT_BACKLOG_WARN_DEPTH;
	return parsed;
}

function resolveBacklogHardMax(): number {
	const raw = process.env.PIT_EVENT_STREAM_MAX_DEPTH;
	if (raw === undefined) return DEFAULT_BACKLOG_HARD_MAX;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed)) return DEFAULT_BACKLOG_HARD_MAX;
	return parsed;
}

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private head = 0;
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	private done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;
	// One-shot rate limit so a pathological backlog logs exactly once per stream.
	private warnedBacklog = false;
	// Resolved once at construction; reading env per-push would be wasteful.
	private backlogWarnDepth = resolveBacklogWarnDepth();
	private backlogHardMax = resolveBacklogHardMax();

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
			// Live backlog = queued entries not yet consumed by the cursor.
			const depth = this.queue.length - this.head;
			if (!this.warnedBacklog && depth >= this.backlogWarnDepth && this.backlogWarnDepth > 0) {
				this.warnedBacklog = true;
				recordDiagnostic({
					category: "stream.backpressure",
					level: "warn",
					source: "event-stream.push",
					context: { note: "backlog", bytes: depth },
				});
				console.warn(
					`[EventStream] backlog reached ${depth} events (consumer slower than producer); ` +
						"events are buffered, not dropped. Set PIT_EVENT_STREAM_WARN_DEPTH to tune.",
				);
			}
			if (this.backlogHardMax > 0 && depth >= this.backlogHardMax) {
				recordDiagnostic({
					category: "stream.backpressure",
					level: "error",
					source: "event-stream.push",
					context: { note: "hard-cap", bytes: depth },
				});
				throw new Error(
					`EventStream backlog exceeded ${this.backlogHardMax} events (consumer slower than producer). ` +
						"Set PIT_EVENT_STREAM_MAX_DEPTH to tune (<=0 disables).",
				);
			}
		}
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter({ value: undefined as any, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.head < this.queue.length) {
				// Cursor over the queue instead of shift() (O(n) per dequeue);
				// compact periodically so consumed entries don't pin memory.
				const event = this.queue[this.head++]!;
				if (this.head > 1024) {
					this.queue.splice(0, this.head);
					this.head = 0;
				}
				yield event;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
