import { join } from "node:path";
import { getDocsPath } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

export function getProviderLoginHelp(): string {
	return [
		"Use /login to log into a provider via OAuth or API key. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}

/**
 * True when an OAuth-refresh failure is permanent — the stored refresh token was
 * revoked or expired, so re-login is required and retrying is futile. Distinct
 * from a transient network/5xx blip during refresh, which should still be retried.
 */
export function isOAuthReauthRequired(message: string | undefined): boolean {
	if (!message) return false;
	return /invalid_grant|refresh token not found or invalid/i.test(message);
}

/**
 * Short, actionable message for a permanently-failed OAuth refresh. Replaces the
 * raw "Failed to refresh OAuth token for …" technical string in the UI.
 */
export function formatOAuthReauthMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected provider" : provider;
	const loginTarget = provider === UNKNOWN_PROVIDER ? "" : ` ${provider}`;
	return `Your ${providerDisplay} session expired or was revoked. Run '/login${loginTarget}' to re-authenticate.`;
}
