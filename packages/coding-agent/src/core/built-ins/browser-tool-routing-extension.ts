/**
 * Turn-scoped Chrome DevTools routing.
 *
 * Chrome is useful but expensive in every tool schema. Keep it out of the
 * default surface and activate a small family only when the prompt is clearly
 * about a browser, page, or rendered UI. Activation is append-only within a
 * session: see `routeBrowserTools`.
 */

import type { ExtensionAPI } from "../extensions/index.js";
import { chromeFeatureToolNames } from "../tools/index.ts";

const NAVIGATION_TOOLS = [
	"chrome_devtools_list_pages",
	"chrome_devtools_select_page",
	"chrome_devtools_navigate",
	"chrome_devtools_screenshot",
	"chrome_devtools_snapshot",
	"chrome_devtools_get_text",
] as const;

const INTERACTION_TOOLS = [
	"chrome_devtools_click",
	"chrome_devtools_fill",
	"chrome_devtools_press_key",
	"chrome_devtools_hover",
	"chrome_devtools_select_option",
	"chrome_devtools_upload_file",
] as const;

const DIAGNOSTIC_TOOLS = [
	"chrome_devtools_evaluate",
	"chrome_devtools_read_console",
	"chrome_devtools_read_network",
	"chrome_devtools_get_network_body",
	"chrome_devtools_element_to_source",
] as const;

const BROWSER_STRONG_INTENT = /\b(browser|chrome|devtools?|web page|webpage|website|rendered|screenshot)\b/i;
// `url`/`site`/`console`/`network`/`element`/`dom`/`selector` are everyday words in a
// code session, so on their own they must not flip the surface; they only count next
// to an explicit navigation/rendering signal.
const BROWSER_AMBIGUOUS_INTENT = /\b(url|site|console|network|element|dom|selector)\b/i;
const BROWSER_NAVIGATION_SIGNAL = /(https?:\/\/|\b(page|browser|localhost|devtools|render(?:s|ed|ing)?)\b)/i;
const INTERACTION_INTENT = /\b(click|fill|type|enter|press|hover|select|upload|login|form|button)\b/i;
const DIAGNOSTIC_INTENT =
	/\b(console|network|request|response|dom|html|css|evaluate|javascript|debug|inspect|source)\b/i;
const WAIT_INTENT = /\b(wait|load|loaded|render)\b/i;

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

/** True when the turn's prompt is clearly about a browser, page, or rendered UI. */
export function hasBrowserIntent(prompt: string): boolean {
	if (BROWSER_STRONG_INTENT.test(prompt)) return true;
	return BROWSER_AMBIGUOUS_INTENT.test(prompt) && BROWSER_NAVIGATION_SIGNAL.test(prompt);
}

/** Explicit teardown; the router itself never removes, see `routeBrowserTools`. */
export function stripBrowserTools(currentNames: string[]): string[] {
	const chrome = new Set<string>(chromeFeatureToolNames as readonly string[]);
	return currentNames.filter((name) => !chrome.has(name));
}

/**
 * Pure router used by the extension and focused tests.
 *
 * Append-only: tool activation rewrites the `Available tools:` section inside the
 * cached system-prompt prefix, so dropping a tool on a later turn costs a full
 * prefix cache miss. A turn without browser intent leaves the surface untouched.
 */
export function routeBrowserTools(prompt: string, availableNames: string[], currentNames: string[]): string[] {
	if (!hasBrowserIntent(prompt)) return currentNames;
	const available = new Set(availableNames);

	const selected: string[] = [...NAVIGATION_TOOLS];
	if (INTERACTION_INTENT.test(prompt)) selected.push(...INTERACTION_TOOLS);
	if (DIAGNOSTIC_INTENT.test(prompt)) selected.push(...DIAGNOSTIC_TOOLS);
	if (WAIT_INTENT.test(prompt)) selected.push("chrome_devtools_wait_for");
	if (/\b(preview|visual)\b/i.test(prompt)) selected.push("preview");

	return unique([...currentNames, ...selected.filter((name) => available.has(name))]);
}

export function createBrowserToolRoutingExtension(options: { isEnabled?: () => boolean } = {}) {
	return (pi: ExtensionAPI) => {
		pi.on("before_agent_start", (event) => {
			try {
				const current = pi.getActiveTools();
				const chromeNames = new Set<string>(chromeFeatureToolNames);
				if (options.isEnabled && !options.isEnabled()) {
					// One-shot teardown on a config change: without the guard this would
					// rewrite the cached prefix on every turn of a disabled session.
					if (current.some((name) => chromeNames.has(name))) pi.setActiveTools(stripBrowserTools(current));
					return undefined;
				}
				if (!hasBrowserIntent(event.prompt)) return undefined;
				const available = pi.getAllTools().map((tool) => tool.name);
				const next = routeBrowserTools(event.prompt, available, current);
				if (next.length !== current.length) pi.setActiveTools(next);
				if (next.some((name) => chromeNames.has(name))) {
					return {
						systemPrompt: `${event.systemPrompt}\n\nBrowser tools are enabled for this turn; use only the smallest relevant subset and verify the rendered result when applicable.`,
					};
				}
				return undefined;
			} catch {
				return undefined;
			}
		});
	};
}
