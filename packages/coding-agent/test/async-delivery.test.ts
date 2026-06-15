import { describe, expect, it } from "vitest";
import { buildAsyncDeliveryBody } from "../src/core/coordinator/async-delivery.js";

describe("buildAsyncDeliveryBody", () => {
	it("formats a completed subagent result as a self-contained block", () => {
		const body = buildAsyncDeliveryBody("task-1", "done", "the answer is 42");
		expect(body).toContain("[ASYNC DELEGATION COMPLETE]");
		expect(body).toContain("task-1");
		expect(body).toContain("the answer is 42");
	});

	it("formats an errored subagent distinctly", () => {
		const body = buildAsyncDeliveryBody("task-2", "error", "boom");
		expect(body).toContain("[ASYNC DELEGATION FAILED]");
		expect(body).toContain("task-2");
		expect(body).toContain("boom");
	});

	it("is a single string ending in the raw payload (no trailing instructions)", () => {
		const body = buildAsyncDeliveryBody("h", "done", "PAYLOAD");
		expect(body.trimEnd().endsWith("PAYLOAD")).toBe(true);
	});
});
