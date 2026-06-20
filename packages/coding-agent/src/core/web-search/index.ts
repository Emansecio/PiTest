/**
 * Public barrel for the web_search subsystem. Re-exports the provider, chain,
 * and extractor surfaces and offers a small helper for the default chain
 * (env-key filtered).
 */

export { autoSearchChain, type ChainAttempt, type ChainOutcome, type ChainResult } from "./chain.ts";
export { type ExtractedContent, extractFromUrl, htmlToMarkdown, stripBoilerplate } from "./extractors.ts";
export {
	ALL_PROVIDERS,
	availableProviders,
	braveProvider,
	exaProvider,
	jinaProvider,
	perplexityProvider,
	type SearchHit,
	type SearchProvider,
	tavilyProvider,
} from "./providers.ts";

import {
	availableProviders,
	braveProvider,
	exaProvider,
	jinaProvider,
	perplexityProvider,
	type SearchProvider,
	tavilyProvider,
} from "./providers.ts";

/**
 * Default provider chain order: Brave → Tavily → Jina → Perplexity → Exa.
 * Filtered down to providers whose env var is present, so an empty array means
 * the caller hasn't configured any API keys.
 */
export function getDefaultProviderChain(): SearchProvider[] {
	return availableProviders([braveProvider, tavilyProvider, jinaProvider, perplexityProvider, exaProvider]);
}
