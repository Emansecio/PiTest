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

export interface PreviewToolOptions {
	/**
	 * Hard ceiling in ms for the whole render (navigate → settle → screenshot).
	 * Overridable for tests; production uses {@link TOTAL_TIMEOUT_MS}.
	 */
	totalTimeoutMs?: number;
}

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
// Hard ceiling for the whole render. settle() is bounded, but navigate/screenshot
// are raw CDP round-trips: a stuck tab or an open native dialog can hold them —
// and with them the turn's step boundary — hostage indefinitely (observed: a
// 12-minute hang). Generous enough for a slow dev server + fullPage capture.
const TOTAL_TIMEOUT_MS = 30_000;

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

/**
 * Settle with `promise`, but reject as soon as `signal` aborts — even when the
 * underlying call cannot observe the signal (getConn's WS connect inside
 * `navigate({newTab})` takes no signal at all). The orphaned promise is left to
 * settle in the background; its handlers are attached, so it never surfaces as
 * an unhandled rejection.
 */
function underSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const onAbort = () =>
			rejectPromise(signal.reason instanceof Error ? signal.reason : new Error("Request was aborted"));
		if (signal.aborted) {
			onAbort();
			promise.catch(() => {});
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolvePromise(value);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				rejectPromise(err);
			},
		);
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
	options?: PreviewToolOptions,
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
			// Every CDP call below runs under one total deadline: whichever of them
			// hangs, the tool fails with a clear timeout instead of holding the turn.
			// The signal makes the CDP layer bail fast where it can; the underSignal
			// wrapper guarantees the deadline even where it can't (see its docs).
			const timeoutMs = options?.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
			const deadline = AbortSignal.timeout(timeoutMs);
			const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
			try {
				await underSignal(mgr.navigate({ url: resolved.url, newTab: true }, combined), combined);
				await settle(mgr, input.waitMs ?? SETTLE_DEFAULT_MS, combined);
				const shot = await underSignal(mgr.screenshot({ fullPage: input.fullPage }, combined), combined);
				const consoleErrors = mgr.readConsole({ level: "error", limit: 20 });
				const network = mgr.readNetwork({ limit: 100 });
				const failures = network.filter((e) => typeof e.status === "number" && e.status >= 400);
				return {
					content: [
						{ type: "image", data: shot.data, mimeType: shot.mimeType } as ImageContent,
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
				// A user abort also aborts `combined`; only the deadline firing alone
				// counts as a timeout — never convert the user's own abort into one.
				if (deadline.aborted && !signal?.aborted) {
					return fail(
						`Preview timed out after ${Math.round(timeoutMs / 1000)}s — Chrome did not respond ` +
							`(stuck tab or open dialog?). Close it and retry, or check the page manually.`,
					);
				}
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

export const createPreviewTool = (cwd: string, options?: PreviewToolOptions): AgentTool<typeof previewSchema> =>
	wrapToolDefinition(createPreviewToolDefinition(cwd, options));
