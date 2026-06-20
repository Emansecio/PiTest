/**
 * `preview` tool — the one-call "see it" loop for rendered work.
 *
 * Renders a web UI/site in the user's Chrome (native CDP, see core/chrome/) and
 * returns a screenshot together with console errors and failed network requests,
 * so "valid code" can be checked against "looks right" in a single step. Local
 * HTML files and directories are served on an ephemeral port (core/preview/) so
 * the `file://` block does not bite; dev-server / remote URLs open directly.
 *
 * Degrades with a clear message when Chrome is not reachable, mirroring the
 * `chrome_devtools_*` tools it builds on.
 */

import type { AgentTool } from "@pit/agent-core";
import type { ImageContent, TextContent } from "@pit/ai";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import { getCurrentChromeDevtoolsManager } from "../chrome/chrome-devtools-manager.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { resolvePreviewTarget } from "../preview/preview-server.ts";
import { getTextOutput } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export interface PreviewToolOptions {}

export interface PreviewToolDetails {
	ok: boolean;
	url?: string;
	consoleErrors?: number;
	networkFailures?: number;
	error?: string;
}

type Content = TextContent | ImageContent;
type PreviewResult = { content: Content[]; details: PreviewToolDetails };
type Manager = NonNullable<ReturnType<typeof getCurrentChromeDevtoolsManager>>;

const SETTLE_DEFAULT_MS = 400;
const READY_TIMEOUT_MS = 8000;
const READY_POLL_MS = 120;

const previewSchema = Type.Object(
	{
		target: Type.String({
			description:
				"What to render: a URL (e.g. http://localhost:5173), a local HTML file, or a directory to serve as a static site. URLs open directly; local files/dirs are served on an ephemeral port so file:// blocking does not apply.",
		}),
		fullPage: Type.Optional(
			Type.Boolean({
				description: "Capture the full scrollable page instead of just the viewport (default false).",
			}),
		),
		waitMs: Type.Optional(
			Type.Number({
				description:
					"Extra settle time in ms after load before the screenshot, for async render/animation (default 400).",
			}),
		),
	},
	{ additionalProperties: false },
);

export type PreviewToolInput = Static<typeof previewSchema>;

function fail(message: string): PreviewResult {
	return { content: [{ type: "text", text: message }], details: { ok: false, error: message } };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolvePromise) => {
		if (ms <= 0) {
			resolvePromise();
			return;
		}
		const onAbort = () => {
			clearTimeout(id);
			resolvePromise();
		};
		const id = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolvePromise();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Wait for document.readyState === "complete" (bounded), then an extra settle. */
async function settle(mgr: Manager, extraMs: number, signal: AbortSignal | undefined): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (signal?.aborted) return;
		const r = await mgr.evaluate("document.readyState", signal);
		if (r.value === "complete" || r.description === "complete") break;
		await delay(READY_POLL_MS, signal);
	}
	await delay(Math.max(0, extraMs), signal);
}

function buildSummary(
	label: string,
	consoleErrors: { level: string; text: string }[],
	failures: { status?: number; method: string; url: string }[],
): string {
	const lines = [`Rendered ${label}.`];
	if (consoleErrors.length === 0) {
		lines.push("Console: no errors.");
	} else {
		lines.push(`Console errors (${consoleErrors.length}):`);
		for (const l of consoleErrors.slice(0, 10)) lines.push(`  [${l.level}] ${l.text}`);
	}
	if (failures.length === 0) {
		lines.push("Network: no failed requests.");
	} else {
		lines.push(`Failed requests (${failures.length}):`);
		for (const e of failures.slice(0, 10)) lines.push(`  ${e.status ?? "?"} ${e.method} ${e.url}`);
	}
	lines.push("Review the screenshot against the intent; treat console errors and failed requests as defects.");
	return lines.join("\n");
}

export function createPreviewToolDefinition(
	cwd: string,
	_options?: PreviewToolOptions,
): ToolDefinition<typeof previewSchema, PreviewToolDetails> {
	return {
		name: "preview",
		label: "preview",
		description:
			"Render a web UI/site and return a screenshot plus console errors and failed network requests — the one-call way to actually look at rendered work. Serves a local HTML file or directory on an ephemeral port (so file:// blocking does not apply), or opens a dev-server/remote URL directly. Use after changing any rendered artifact, before reporting it done.",
		promptSnippet: "Render a UI/site → screenshot + console + network",
		promptGuidelines: [
			"Pass a URL (e.g. http://localhost:5173), a local .html file, or a directory to serve as a static site. For a framework dev server, start it (bash) and pass its URL.",
			"Console errors or failed requests count as defects even when the screenshot looks right — fix and re-preview.",
		],
		parameters: previewSchema,
		async execute(_toolCallId: string, input: PreviewToolInput, signal: AbortSignal | undefined) {
			const mgr = getCurrentChromeDevtoolsManager();
			if (!mgr) {
				return fail(
					"Preview needs Chrome DevTools (chromeDevtools.enabled — on by default). Ensure Chrome is reachable and retry.",
				);
			}
			let resolved: Awaited<ReturnType<typeof resolvePreviewTarget>>;
			try {
				resolved = await resolvePreviewTarget(input.target, cwd);
			} catch (err) {
				return fail((err as Error).message);
			}
			try {
				await mgr.navigate({ url: resolved.url, newTab: true }, signal);
				await settle(mgr, input.waitMs ?? SETTLE_DEFAULT_MS, signal);
				const data = await mgr.screenshot({ fullPage: input.fullPage }, signal);
				const consoleErrors = mgr.readConsole({ level: "error", limit: 20 });
				const network = mgr.readNetwork({ limit: 100 });
				const failures = network.filter((e) => typeof e.status === "number" && e.status >= 400);
				return {
					content: [
						{ type: "image", data, mimeType: "image/png" } as ImageContent,
						{ type: "text", text: buildSummary(resolved.label, consoleErrors, failures) } as TextContent,
					],
					details: {
						ok: true,
						url: resolved.url,
						consoleErrors: consoleErrors.length,
						networkFailures: failures.length,
					},
				};
			} catch (err) {
				return fail((err as Error).message);
			} finally {
				await resolved.server?.close();
			}
		},
		renderCall(_args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold("preview")));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result, context.showImages).trim();
			text.setText(output ? `${theme.fg("toolOutput", output)}` : "");
			return text;
		},
	};
}

export const createPreviewTool = (cwd: string, _o?: PreviewToolOptions): AgentTool<typeof previewSchema> =>
	wrapToolDefinition(createPreviewToolDefinition(cwd));
