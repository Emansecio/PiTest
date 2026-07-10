/**
 * T3 #7: the retry countdown discarded the event's errorMessage, so the user saw
 * a paused timer with no idea whether to wait (transient) or intervene. classify-
 * RetryReason derives a short label; unclassifiable → undefined so the wording
 * stays byte-identical (no misleading guess).
 */

import { describe, expect, it } from "vitest";
import { classifyRetryReason, isThrottleError } from "../src/modes/interactive/retry-reason.ts";

describe("T3 #7: classifyRetryReason", () => {
	it("classifies rate limit", () => {
		expect(classifyRetryReason("HTTP 429: rate limit exceeded")).toBe("Rate limited");
		expect(classifyRetryReason("too many requests, slow down")).toBe("Rate limited");
	});

	it("classifies overload", () => {
		expect(classifyRetryReason("overloaded_error: server is busy")).toBe("Overloaded");
		expect(classifyRetryReason("Error 529 at capacity")).toBe("Overloaded");
	});

	it("classifies timeout and network", () => {
		expect(classifyRetryReason("Request timed out after 60s")).toBe("Timed out");
		expect(classifyRetryReason("connect timeout")).toBe("Timed out");
		expect(classifyRetryReason("fetch failed: ECONNRESET")).toBe("Network error");
		expect(classifyRetryReason("socket hang up")).toBe("Network error");
	});

	it("classifies generic server errors last", () => {
		expect(classifyRetryReason("503 Service Unavailable")).toBe("Server error");
	});

	it("returns undefined for unclassifiable / empty (wording kept unchanged)", () => {
		expect(classifyRetryReason("some unusual provider message")).toBeUndefined();
		expect(classifyRetryReason("")).toBeUndefined();
		expect(classifyRetryReason(undefined)).toBeUndefined();
	});
});

describe("isThrottleError (Fusion §12)", () => {
	it("detects throttle patterns", () => {
		expect(isThrottleError("HTTP 429: rate limit exceeded")).toBe(true);
		expect(isThrottleError("request throttled")).toBe(true);
		expect(isThrottleError("overloaded_error: server is busy")).toBe(true);
		expect(isThrottleError("too many requests")).toBe(true);
	});

	it("rejects non-throttle failures", () => {
		expect(isThrottleError("not logged in")).toBe(false);
		expect(isThrottleError("Request timed out after 60s")).toBe(false);
		expect(isThrottleError(undefined)).toBe(false);
	});
});
