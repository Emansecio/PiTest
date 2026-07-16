/**
 * Hermetic unit tests for the live-E2E auth autoskip helper (no network, no
 * credentials): classifier precision + wrapper skip/hard-fail behavior.
 */
import { afterEach, describe, expect, it, type TestContext, vi } from "vitest";
import { describeAuthFailure, live, liveAutoskipEnabled } from "./live.js";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("describeAuthFailure", () => {
	it("classifies Anthropic SDK 401 authentication_error payloads", () => {
		const message = '401 {"type":"error","error":{"type":"authentication_error","message":"invalid bearer token"}}';
		expect(describeAuthFailure(new Error(message))).toBeTruthy();
	});

	it("classifies assertion messages that embed a provider errorMessage", () => {
		// e.g. `expect(response.stopReason, response.errorMessage).not.toBe("error")`
		const assertion = new Error("OAuth token has expired.: expected 'error' not to be 'error' // Object.is equality");
		expect(describeAuthFailure(assertion)).toBe("expired/revoked credential");
	});

	it("classifies toBeFalsy failures over errorMessage", () => {
		expect(describeAuthFailure(new Error("expected '403 permission_error: forbidden' to be falsy"))).toBeTruthy();
	});

	it("classifies Codex backend auth texts", () => {
		expect(describeAuthFailure(new Error("Your ChatGPT session has expired"))).toBe("expired/revoked credential");
		expect(describeAuthFailure(new Error("Missing scopes"))).toBe("missing scopes");
		expect(describeAuthFailure(new Error("Unauthorized"))).toBe("unauthorized");
	});

	it("classifies OAuth refresh failures (invalid_grant)", () => {
		expect(describeAuthFailure(new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}'))).toBe(
			"invalid_grant",
		);
		expect(describeAuthFailure(new Error("Failed to refresh OAuth token for openai-codex: HTTP 400"))).toBeTruthy();
	});

	it("classifies errors carrying an HTTP status field", () => {
		const err = Object.assign(new Error("Request failed"), { status: 401 });
		expect(describeAuthFailure(err)).toBe("HTTP 401");
		const nested = new Error("wrapper", { cause: Object.assign(new Error("inner"), { statusCode: 403 }) });
		expect(describeAuthFailure(nested)).toBe("HTTP 403");
	});

	it("does not classify plain assertion or transport failures", () => {
		expect(describeAuthFailure(new Error("expected 401 to be greater than 500"))).toBeUndefined();
		expect(describeAuthFailure(new Error("expected 'stop' not to be 'error'"))).toBeUndefined();
		expect(describeAuthFailure(new Error("read ECONNRESET"))).toBeUndefined();
		expect(describeAuthFailure(new Error("rate limit exceeded, retry later"))).toBeUndefined();
		expect(describeAuthFailure(undefined)).toBeUndefined();
		expect(describeAuthFailure(new Error(""))).toBeUndefined();
	});
});

type FakeCtx = { skip: (note?: string) => never; skippedWith?: string };

function makeFakeCtx(): FakeCtx {
	const ctx: FakeCtx = {
		skip: (note?: string) => {
			ctx.skippedWith = note ?? "";
			// Mirrors vitest: ctx.skip() aborts the test body by throwing.
			throw Object.assign(new Error("__test_skipped__"), { __skipped: true });
		},
	};
	return ctx;
}

describe("live wrapper", () => {
	it("skips on auth-shaped failure when autoskip is enabled", async () => {
		vi.stubEnv("CI", "");
		vi.stubEnv("PIT_NO_E2E_AUTOSKIP", "");
		const ctx = makeFakeCtx();
		const wrapped = live("openai-codex", async () => {
			throw new Error('401 {"error":{"type":"authentication_error"}}');
		});
		await expect(wrapped(ctx as unknown as TestContext)).rejects.toMatchObject({ __skipped: true });
		expect(ctx.skippedWith).toContain("credencial openai-codex inválida");
		expect(ctx.skippedWith).toContain("PIT_NO_E2E_AUTOSKIP");
	});

	it("rethrows non-auth failures untouched", async () => {
		vi.stubEnv("CI", "");
		vi.stubEnv("PIT_NO_E2E_AUTOSKIP", "");
		const ctx = makeFakeCtx();
		const wrapped = live("anthropic", async () => {
			throw new Error("expected 2 to be 3");
		});
		await expect(wrapped(ctx as unknown as TestContext)).rejects.toThrow("expected 2 to be 3");
		expect(ctx.skippedWith).toBeUndefined();
	});

	it("hard-fails auth errors when CI is set", async () => {
		vi.stubEnv("CI", "true");
		const ctx = makeFakeCtx();
		const wrapped = live("anthropic", async () => {
			throw new Error("unauthorized");
		});
		expect(liveAutoskipEnabled()).toBe(false);
		await expect(wrapped(ctx as unknown as TestContext)).rejects.toThrow("unauthorized");
		expect(ctx.skippedWith).toBeUndefined();
	});

	it("hard-fails auth errors with PIT_NO_E2E_AUTOSKIP=1", async () => {
		vi.stubEnv("CI", "");
		vi.stubEnv("PIT_NO_E2E_AUTOSKIP", "1");
		const ctx = makeFakeCtx();
		const wrapped = live("anthropic", async () => {
			throw new Error("unauthorized");
		});
		await expect(wrapped(ctx as unknown as TestContext)).rejects.toThrow("unauthorized");
		expect(ctx.skippedWith).toBeUndefined();
	});

	it("passes through a passing body (and forwards the context)", async () => {
		vi.stubEnv("CI", "");
		const ctx = makeFakeCtx();
		let sawCtx: unknown;
		const wrapped = live("anthropic", async (received) => {
			sawCtx = received;
		});
		await expect(wrapped(ctx as unknown as TestContext)).resolves.toBeUndefined();
		expect(sawCtx).toBe(ctx);
	});
});
