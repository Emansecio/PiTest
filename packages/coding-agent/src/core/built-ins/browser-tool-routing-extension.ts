/**
 * Turn-scoped Chrome DevTools routing.
 *
 * Chrome is useful but expensive in every tool schema. Keep it out of the
 * default surface and activate a small family only when the prompt is clearly
 * about a browser, page, DOM, or rendered UI.
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

const BROWSER_INTENT =
	/\b(browser|chrome|devtools?|web page|webpage|website|site|url|dom|rendered|screenshot|console|network|selector|element)\b/i;
const INTERACTION_INTENT = /\b(click|fill|type|enter|press|hover|select|upload|login|form|button)\b/i;
const DIAGNOSTIC_INTENT =
	/\b(console|network|request|response|dom|html|css|evaluate|javascript|debug|inspect|source)\b/i;
const WAIT_INTENT = /\b(wait|load|loaded|render)\b/i;

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

/** Pure router used by the extension and focused tests. */
export function routeBrowserTools(prompt: string, availableNames: string[], currentNames: string[]): string[] {
	const available = new Set(availableNames);
	const chrome = new Set<string>(chromeFeatureToolNames as readonly string[]);
	const next = currentNames.filter((name) => !chrome.has(name));
	if (!BROWSER_INTENT.test(prompt)) return next;

	const selected: string[] = [...NAVIGATION_TOOLS];
	if (INTERACTION_INTENT.test(prompt)) selected.push(...INTERACTION_TOOLS);
	if (DIAGNOSTIC_INTENT.test(prompt)) selected.push(...DIAGNOSTIC_TOOLS);
	if (WAIT_INTENT.test(prompt)) selected.push("chrome_devtools_wait_for");
	if (/\b(preview|visual)\b/i.test(prompt)) selected.push("preview");

	return unique([...next, ...selected.filter((name) => available.has(name))]);
}

export function createBrowserToolRoutingExtension(options: { isEnabled?: () => boolean } = {}) {
	return (pi: ExtensionAPI) => {
		pi.on("before_agent_start", (event) => {
			try {
				if (options.isEnabled && !options.isEnabled()) {
					pi.setActiveTools(routeBrowserTools("", [], pi.getActiveTools()));
					return undefined;
				}
				const available = pi.getAllTools().map((tool) => tool.name);
				const next = routeBrowserTools(event.prompt, available, pi.getActiveTools());
				pi.setActiveTools(next);
				const chromeNames = new Set<string>(chromeFeatureToolNames);
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
