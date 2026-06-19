import { afterEach, describe, expect, it } from "vitest";
import {
	getOAuthApiKey,
	registerOAuthProvider,
	resetOAuthProviders,
	unregisterOAuthProvider,
} from "../src/utils/oauth/index.js";
import type { OAuthCredentials, OAuthProviderInterface } from "../src/utils/oauth/types.js";

afterEach(() => {
	resetOAuthProviders();
});

function fakeProvider(id: string, onRefresh: () => void): OAuthProviderInterface {
	return {
		id,
		name: id,
		login: async () => ({ refresh: "r", access: "a", expires: 0 }),
		refreshToken: async (creds: OAuthCredentials) => {
			onRefresh();
			return { ...creds, access: "refreshed", expires: Date.now() + 3_600_000 };
		},
		getApiKey: (creds) => creds.access,
	};
}

/**
 * Regression for #38: getOAuthApiKey must refresh a token that is technically
 * still valid "now" but expires within a short buffer window, so a request
 * doesn't reach the server with an already-expired credential.
 */
describe("getOAuthApiKey proactive refresh buffer", () => {
	it("refreshes when the token expires within the buffer window", async () => {
		let refreshed = 0;
		registerOAuthProvider(fakeProvider("fake-codex", () => refreshed++));
		try {
			const creds: Record<string, OAuthCredentials> = {
				"fake-codex": { refresh: "r", access: "stale", expires: Date.now() + 30_000 },
			};
			const result = await getOAuthApiKey("fake-codex", creds);
			expect(refreshed).toBe(1);
			expect(result?.apiKey).toBe("refreshed");
		} finally {
			unregisterOAuthProvider("fake-codex");
		}
	});

	it("does not refresh a token comfortably in the future", async () => {
		let refreshed = 0;
		registerOAuthProvider(fakeProvider("fake-codex2", () => refreshed++));
		try {
			const creds: Record<string, OAuthCredentials> = {
				"fake-codex2": { refresh: "r", access: "fresh", expires: Date.now() + 3_600_000 },
			};
			const result = await getOAuthApiKey("fake-codex2", creds);
			expect(refreshed).toBe(0);
			expect(result?.apiKey).toBe("fresh");
		} finally {
			unregisterOAuthProvider("fake-codex2");
		}
	});
});
