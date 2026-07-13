/**
 * ChromeDevtoolsManager — session-scoped state for the chrome_devtools_* tools.
 *
 * Holds the resolved endpoint (host/port), a cache of CDP connections keyed by
 * targetId, the currently selected page, and ring buffers of console/network
 * events per connection. Connects to a reachable Chrome (started with
 * --remote-debugging-port) and can open a NEW tab via the DevTools HTTP
 * endpoint. When `launchBrowser` is set (the default), ownership is proven via
 * the dedicated profile's `DevToolsActivePort` (ephemeral port 0) — never by
 * "something answered on debugPort". With `launchBrowser: false`, attaches to
 * the configured host:port (power-user escape hatch). Published via a
 * module-level registry (mirrors goal/todo/preview-queue).
 */

import { existsSync } from "node:fs";
import { recordDiagnostic } from "@pit/ai";
import { sliceSafe } from "../../utils/surrogate.ts";
import { redactHttpBody, redactHttpHeaders, redactHttpUrl } from "../security/redaction.ts";
import {
	CdpConnection,
	type CdpTarget,
	closeTarget as defaultCloseTarget,
	createTarget as defaultCreateTarget,
	listTargets as defaultListTargets,
} from "./cdp-client.ts";
import {
	type DevToolsActivePort,
	findChromeBinary,
	isOwnedEndpoint,
	launchChrome,
	readDevToolsActivePort,
	waitForOwnedProfile,
} from "./chrome-launcher.ts";
import { type ElementToSourceResult, resolveElementToSource } from "./element-to-source.ts";

export interface CdpConnectionLike {
	send(
		method: string,
		params?: Record<string, unknown>,
		opts?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<any>;
	on(eventMethod: string, handler: (params: any) => void): () => void;
	close(): void;
	/** Optional so test fakes stay minimal; absent = assumed alive. */
	isClosed?(): boolean;
}

export interface ConsoleLine {
	level: string;
	text: string;
}

export interface NetworkEntry {
	/** Stable identity for one hop. CDP reuses requestId across redirects. */
	entryId: string;
	requestId: string;
	hop: number;
	method: string;
	url: string;
	requestHeaders?: Record<string, string>;
	requestHeadersSource?: "request" | "extra-info";
	requestBody?: string;
	requestBodyTruncated?: boolean;
	/** Monotonic CDP timestamp converted to milliseconds. */
	startedAtMs?: number;
	wallTimeMs?: number;
	status?: number;
	mimeType?: string;
	responseHeaders?: Record<string, string>;
	responseHeadersSource?: "response" | "extra-info";
	responseBody?: string;
	responseBodyTruncated?: boolean;
	protocol?: string;
	timing?: Record<string, number>;
	durationMs?: number;
	encodedDataLength?: number;
	failureText?: string;
	canceled?: boolean;
	/** CDP resource type (Document/Script/XHR/Fetch/Image/Font/…) — used by readNetwork filters. */
	resourceType?: string;
	redirectFromEntryId?: string;
	redirectToEntryId?: string;
	initiator?: {
		type: string;
		url?: string;
		lineNumber?: number;
		columnNumber?: number;
		requestId?: string;
	};
	associatedCookies?: Array<{ name: string; blockedReasons: string[] }>;
	blockedResponseCookies?: Array<{ blockedReasons: string[] }>;
}

export interface CapturedXhrPatch {
	headers?: Record<string, string>;
	body?: string;
}

export interface ChromeDevtoolsDeps {
	host: string;
	/**
	 * Preferred debug port. Used as the attach target when `launchBrowser` is
	 * false. Ignored for ownership when auto-launch is on (ephemeral port +
	 * `DevToolsActivePort` instead).
	 */
	port: number;
	/** Auto-launch Chrome into `userDataDir` when our profile is not live. */
	launchBrowser?: boolean;
	/** Dedicated, persistent profile dir for the launched Chrome. */
	userDataDir?: string;
	/** Explicit Chrome binary path (else auto-discovered). */
	binaryPath?: string;
	list?: (signal?: AbortSignal) => Promise<CdpTarget[]>;
	create?: (url: string, signal?: AbortSignal) => Promise<CdpTarget>;
	close?: (id: string, signal?: AbortSignal) => Promise<void>;
	connect?: (target: CdpTarget) => CdpConnectionLike;
	// Injectable launcher pieces (tests).
	findBinary?: () => string | undefined;
	launch?: (opts: { binary: string; port: number; userDataDir: string }) => void;
	readActivePort?: () => DevToolsActivePort | undefined;
	isOwned?: (host: string, port: number, browserPath: string, signal?: AbortSignal) => Promise<boolean>;
	waitOwned?: (host: string, userDataDir: string, signal?: AbortSignal) => Promise<DevToolsActivePort | undefined>;
}

interface ConnState {
	conn: CdpConnectionLike;
	console: ConsoleLine[];
	network: NetworkEntry[];
	/** O(1) lookup by requestId — entries are the same objects as in `network`. */
	networkById: Map<string, NetworkEntry>;
	networkByEntryId: Map<string, NetworkEntry>;
	requestExtraAssigned: Set<string>;
	responseExtraAssigned: Set<string>;
	pendingRequestExtra: Map<string, any[]>;
	pendingResponseExtra: Map<string, any[]>;
	// Proactively captured response bodies, keyed by requestId. CDP evicts bodies
	// from its own buffer as new requests pile up (and on navigation), so a body
	// fetched lazily by getResponseBody is often already gone. We snapshot text-ish
	// bodies on Network.loadingFinished instead, so they stay readable for the page's
	// lifetime. Bounded by BODY_CACHE_BUDGET (total) + BODY_CACHE_PER_ENTRY (each).
	bodies: Map<string, { body: string; base64Encoded: boolean; bytes: number; truncated: boolean }>;
	bodyBytes: number;
	unsubs: Array<() => void>;
	// Memoized "renderer ready for synthetic input" gate (see ensureInputReady).
	// One per connection: a freshly launched/navigated page drops Input.dispatch*
	// events until its compositor has produced a frame, so the first interaction
	// waits on this once.
	inputReady?: Promise<void>;
}

const BUFFER_MAX = 200;
// Proactive network-body cache bounds. Each cached body is capped (complete
// bodies only — anything larger is left to a live getResponseBody fetch), and the
// running total is capped so a flood of JSON responses can't grow without limit.
const BODY_CACHE_PER_ENTRY = 1024 * 1024;
const BODY_CACHE_BUDGET = 16 * 1024 * 1024;
const REQUEST_BODY_PER_ENTRY = 256 * 1024;
// CDP's own response-body buffer (Network.enable). Larger than the default so a
// body we did NOT proactively cache (e.g. a big JS bundle) still survives long
// enough for a live getResponseBody fetch on a busy page.
const NETWORK_TOTAL_BUFFER_BYTES = 64 * 1024 * 1024;
const NETWORK_RESOURCE_BUFFER_BYTES = 16 * 1024 * 1024;
const WAIT_FOR_POLL_MS = 200;
const WAIT_FOR_DEFAULT_TIMEOUT_MS = 5_000;
const WAIT_FOR_MAX_TIMEOUT_MS = 30_000;
const A11Y_SNAPSHOT_MAX_LINES = 800;
// A just-launched / just-navigated renderer accepts Runtime.evaluate (DOM is
// parsed) well before its compositor produces the first frame — and Chrome
// silently DROPS Input.dispatchMouseEvent / dispatchKeyEvent / insertText that
// arrive in that window. The double-rAF below resolves only after a frame has
// been composited; if it stalls we fall back to this short delay rather than
// blocking an interaction forever.
const INPUT_READY_MAX_MS = 2_000;
// Hard ceiling on a single CDP payload (network body / evaluate result) we keep
// and hand downstream. A multi-hundred-MB asset would otherwise be copied into
// the tool result / render / compaction and blow the heap. Truncate at this cap.
const MAX_CDP_BODY_BYTES = 10 * 1024 * 1024;

function boundedText(value: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
	const buffer = Buffer.from(value, "utf8");
	if (buffer.length <= maxBytes) return { text: value, truncated: false, bytes: buffer.length };
	return { text: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true, bytes: maxBytes };
}

function numericTiming(value: unknown): Record<string, number> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const entries = Object.entries(value as Record<string, unknown>).filter(
		(entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function initiatorSummary(value: any): NetworkEntry["initiator"] {
	if (!value || typeof value !== "object") return undefined;
	const callFrame = value.stack?.callFrames?.[0];
	const url = typeof value.url === "string" ? value.url : callFrame?.url;
	return {
		type: typeof value.type === "string" ? value.type : "other",
		...(typeof url === "string" && url ? { url: redactHttpUrl(url) } : {}),
		...(typeof value.lineNumber === "number"
			? { lineNumber: value.lineNumber }
			: typeof callFrame?.lineNumber === "number"
				? { lineNumber: callFrame.lineNumber }
				: {}),
		...(typeof value.columnNumber === "number"
			? { columnNumber: value.columnNumber }
			: typeof callFrame?.columnNumber === "number"
				? { columnNumber: callFrame.columnNumber }
				: {}),
		...(typeof value.requestId === "string" ? { requestId: value.requestId } : {}),
	};
}

function cookieSummaries(value: any): Array<{ name: string; blockedReasons: string[] }> {
	if (!Array.isArray(value)) return [];
	return value.map((item) => ({
		name: typeof item?.cookie?.name === "string" ? item.cookie.name : "(unknown)",
		blockedReasons: Array.isArray(item?.blockedReasons)
			? item.blockedReasons.filter((reason: unknown): reason is string => typeof reason === "string")
			: [],
	}));
}

function blockedCookieSummaries(value: any): Array<{ blockedReasons: string[] }> {
	if (!Array.isArray(value)) return [];
	return value.map((item) => ({
		blockedReasons: Array.isArray(item?.blockedReasons)
			? item.blockedReasons.filter((reason: unknown): reason is string => typeof reason === "string")
			: [],
	}));
}

// Source label for the cap diagnostic, so getResponseBody vs evaluate are distinct.
type CapSource = "chrome.getResponseBody" | "chrome.evaluate";

/** Cap an oversized payload string, replacing the tail with a byte-count marker. */
function capPayload(text: string, max: number, source: CapSource): string {
	if (text.length <= max) return text;
	// Observe only a REAL truncation (over the ceiling), not a normal payload.
	recordDiagnostic({
		category: "output.cap",
		level: "warn",
		source,
		context: { bytes: text.length },
	});
	return `${sliceSafe(text, 0, max)}\n[corpo truncado: ${max} de ${text.length} bytes]`;
}

/**
 * Bound an evaluate result so a huge serialized value never propagates. Small
 * values pass through untouched (identical behavior); only an oversized value is
 * capped to a marker string. Strings cap directly; other types serialize once to
 * measure, and when oversized return the capped JSON text as the value.
 */
function capEvaluateValue(value: unknown): unknown {
	if (typeof value === "string") {
		if (value.length <= MAX_CDP_BODY_BYTES) return value;
		return capPayload(value, MAX_CDP_BODY_BYTES, "chrome.evaluate");
	}
	if (value === undefined || value === null) return value;
	const serialized = safeStringify(value);
	if (serialized === undefined || serialized.length <= MAX_CDP_BODY_BYTES) return value;
	return capPayload(serialized, MAX_CDP_BODY_BYTES, "chrome.evaluate");
}

/** JSON.stringify that swallows cyclic/throwing values (returns undefined). */
function safeStringify(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

/** Named keys for pressKey, mapped to CDP Input.dispatchKeyEvent fields. */
const KEY_DEFS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
	Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
	Tab: { key: "Tab", code: "Tab", keyCode: 9 },
	Escape: { key: "Escape", code: "Escape", keyCode: 27 },
	Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
	Delete: { key: "Delete", code: "Delete", keyCode: 46 },
	ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
	ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
	ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
	ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
	Home: { key: "Home", code: "Home", keyCode: 36 },
	End: { key: "End", code: "End", keyCode: 35 },
	PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
	PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

/**
 * Whether a response body of this MIME type is worth proactively caching. Targets
 * the inspectable bodies an agent actually reads (JSON / text / XML / form data /
 * GraphQL) and skips large static assets (scripts, styles, images, fonts, media)
 * that are rarely examined as network bodies and only bloat the cache.
 */
function isCacheableMime(mime: string): boolean {
	const m = mime.toLowerCase();
	if (m.includes("json")) return true;
	if (m.includes("xml")) return true;
	if (m.includes("graphql")) return true;
	if (m.includes("x-www-form-urlencoded")) return true;
	if (m.startsWith("text/")) return !(m.startsWith("text/javascript") || m.startsWith("text/css"));
	return false;
}

/**
 * Compile a status filter into a predicate. Accepts a number (exact), "NNN"
 * (exact), a class like "2xx"/"4xx"/"5xx", or a comparison ">=400" / ">399" /
 * "<=299" / "<300". Throws on an unrecognized spec so the tool can report it.
 */
function statusMatcher(spec: string | number): (status: number) => boolean {
	if (typeof spec === "number") return (n) => n === spec;
	const s = spec.trim().toLowerCase();
	const cls = /^([1-5])xx$/.exec(s);
	if (cls) {
		const base = Number(cls[1]) * 100;
		return (n) => n >= base && n < base + 100;
	}
	const cmp = /^(>=|<=|>|<)\s*(\d{3})$/.exec(s);
	if (cmp) {
		const v = Number(cmp[2]);
		switch (cmp[1]) {
			case ">=":
				return (n) => n >= v;
			case "<=":
				return (n) => n <= v;
			case ">":
				return (n) => n > v;
			default:
				return (n) => n < v;
		}
	}
	if (/^\d{3}$/.test(s)) {
		const v = Number(s);
		return (n) => n === v;
	}
	throw new Error(`Invalid status filter ${JSON.stringify(spec)}. Use 404, "4xx", ">=400", "<300", etc.`);
}

function remoteArgsToText(args: unknown): string {
	if (!Array.isArray(args)) return "";
	return args
		.map((a) => {
			const o = a as { value?: unknown; description?: string };
			if (o?.value !== undefined) return typeof o.value === "string" ? o.value : JSON.stringify(o.value);
			return o?.description ?? "";
		})
		.join(" ")
		.trim();
}

export class ChromeDevtoolsManager {
	private readonly host: string;
	/** Effective CDP port — updated after owned-profile discover / reconnect. */
	private port: number;
	private readonly list: (signal?: AbortSignal) => Promise<CdpTarget[]>;
	private readonly create: (url: string, signal?: AbortSignal) => Promise<CdpTarget>;
	private readonly closeTargetImpl: (id: string, signal?: AbortSignal) => Promise<void>;
	private readonly connectFactory: (target: CdpTarget) => CdpConnectionLike;
	private readonly launchBrowser: boolean;
	private readonly userDataDir: string;
	private readonly binaryPath: string | undefined;
	private readonly findBinary: () => string | undefined;
	private readonly launch: (opts: { binary: string; port: number; userDataDir: string }) => void;
	private readonly readActivePort: () => DevToolsActivePort | undefined;
	private readonly isOwned: (
		host: string,
		port: number,
		browserPath: string,
		signal?: AbortSignal,
	) => Promise<boolean>;
	private readonly waitOwned: (
		host: string,
		userDataDir: string,
		signal?: AbortSignal,
	) => Promise<DevToolsActivePort | undefined>;

	private selectedTarget: CdpTarget | undefined;
	private readonly conns = new Map<string, ConnState>();
	// In-flight getConn promises keyed by targetId, so concurrent callers for the
	// same target share one connection instead of racing to create (and leak) two.
	private readonly connecting = new Map<string, Promise<CdpConnectionLike>>();
	private ensurePromise: Promise<{ launched: boolean }> | undefined;
	private launchedHere = false;

	constructor(deps: ChromeDevtoolsDeps) {
		this.host = deps.host;
		this.port = deps.port;
		this.launchBrowser = deps.launchBrowser ?? false;
		this.userDataDir = deps.userDataDir ?? "";
		this.binaryPath = deps.binaryPath;
		this.list = deps.list ?? ((signal) => defaultListTargets(this.host, this.port, signal));
		this.create = deps.create ?? ((url, signal) => defaultCreateTarget(this.host, this.port, url, signal));
		this.closeTargetImpl = deps.close ?? ((id, signal) => defaultCloseTarget(this.host, this.port, id, signal));
		this.connectFactory = deps.connect ?? ((target) => new CdpConnection(target.webSocketDebuggerUrl ?? ""));
		this.findBinary = deps.findBinary ?? (() => findChromeBinary());
		this.launch = deps.launch ?? ((opts) => void launchChrome(opts));
		this.readActivePort = deps.readActivePort ?? (() => readDevToolsActivePort(this.userDataDir));
		this.isOwned =
			deps.isOwned ?? ((host, port, browserPath, signal) => isOwnedEndpoint(host, port, browserPath, { signal }));
		this.waitOwned =
			deps.waitOwned ?? ((host, userDataDir, signal) => waitForOwnedProfile(host, userDataDir, { signal }));
	}

	/**
	 * Make sure an owned Chrome is reachable: reconnect to our profile when
	 * `DevToolsActivePort` matches a live endpoint, otherwise auto-launch
	 * (when enabled) with an ephemeral port. Idempotent — concurrent callers
	 * share one ensure. Returns whether a browser was launched.
	 */
	async ensureBrowser(signal?: AbortSignal): Promise<{ launched: boolean }> {
		if (signal?.aborted) {
			throw new DOMException("The operation was aborted.", "AbortError");
		}
		if (!this.ensurePromise) {
			this.ensurePromise = this.doEnsure(signal).finally(() => {
				this.ensurePromise = undefined;
			});
		}
		if (!signal) return this.ensurePromise;
		// Race the shared ensure with this caller's abort so Esc unblocks waiters
		// even when the in-flight ensure was started under a different signal.
		return new Promise<{ launched: boolean }>((resolve, reject) => {
			const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
			signal.addEventListener("abort", onAbort, { once: true });
			this.ensurePromise!.then(
				(value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(err) => {
					signal.removeEventListener("abort", onAbort);
					reject(err);
				},
			);
		});
	}

	private async doEnsure(signal?: AbortSignal): Promise<{ launched: boolean }> {
		if (this.launchBrowser) {
			if (await this.tryReconnectOwned(signal)) return { launched: false };
			const binary = this.binaryPath || this.findBinary();
			if (!binary) {
				throw new Error(
					"Chrome was not found. Install Chrome, or set chromeDevtools.binaryPath / PIT_CHROME_DEVTOOLS_BINARY.",
				);
			}
			if (!this.userDataDir) {
				throw new Error("chromeDevtools userDataDir is required when launchBrowser is enabled.");
			}
			if (signal?.aborted) {
				throw new DOMException("The operation was aborted.", "AbortError");
			}
			// Port 0 → Chrome writes DevToolsActivePort (fixed ports do not).
			this.launch({ binary, port: 0, userDataDir: this.userDataDir });
			const owned = await this.waitOwned(this.host, this.userDataDir, signal);
			if (signal?.aborted) {
				throw new DOMException("The operation was aborted.", "AbortError");
			}
			if (!owned) {
				throw new Error(
					`Launched Chrome but the profile at ${this.userDataDir} did not publish a live DevToolsActivePort in time. ` +
						"If another Chrome is using this profile, close it and retry; or set chromeDevtools.launchBrowser: false to attach to a fixed host:port.",
				);
			}
			this.port = owned.port;
			this.launchedHere = true;
			return { launched: true };
		}
		// Attach-any escape hatch: configured host:port only (no ownership check).
		await this.list(signal);
		return { launched: false };
	}

	/** Reconnect when our profile's DevToolsActivePort points at a live matching endpoint. */
	private async tryReconnectOwned(signal?: AbortSignal): Promise<boolean> {
		const active = this.readActivePort();
		if (!active) return false;
		if (!(await this.isOwned(this.host, active.port, active.browserPath, signal))) return false;
		this.port = active.port;
		return true;
	}

	wasLaunchedHere(): boolean {
		return this.launchedHere;
	}

	endpoint(): string {
		return `${this.host}:${this.port}`;
	}

	selectedPageId(): string | undefined {
		return this.selectedTarget?.id;
	}

	async listPages(signal?: AbortSignal): Promise<CdpTarget[]> {
		await this.ensureBrowser(signal);
		return (await this.list(signal)).filter((t) => t.type === "page");
	}

	async selectPage(targetId: string, signal?: AbortSignal): Promise<CdpTarget> {
		await this.ensureBrowser(signal);
		const target = (await this.list(signal)).find((t) => t.id === targetId);
		if (!target) throw new Error(`No page with id ${targetId}. Use chrome_devtools_list_pages.`);
		this.selectedTarget = target;
		await this.getConn(target);
		return target;
	}

	async navigate(
		input: { url: string; newTab?: boolean },
		signal?: AbortSignal,
	): Promise<{ created: boolean; target: CdpTarget }> {
		await this.ensureBrowser(signal);
		if (input.newTab || !this.selectedTarget) {
			const target = await this.create(input.url, signal);
			this.selectedTarget = target;
			await this.getConn(target);
			return { created: true, target };
		}
		const conn = await this.getConn(this.selectedTarget);
		// A same-tab navigation swaps the renderer, so the input-ready gate of the
		// old document no longer applies — clear it so the next interaction re-waits
		// for the new document's first frame.
		const state = this.conns.get(this.selectedTarget.id);
		if (state) {
			state.inputReady = undefined;
			// The ConnState is reused across a same-tab navigation (it's keyed by
			// target.id, which doesn't change), so the old document's buffered
			// console/network entries and cached bodies would otherwise bleed into
			// reads for the new page. Drop them so reads reflect only the new document.
			state.console.length = 0;
			state.network.length = 0;
			state.networkById.clear();
			state.networkByEntryId.clear();
			state.requestExtraAssigned.clear();
			state.responseExtraAssigned.clear();
			state.pendingRequestExtra.clear();
			state.pendingResponseExtra.clear();
			state.bodies.clear();
			state.bodyBytes = 0;
		}
		await conn.send("Page.navigate", { url: input.url }, { signal });
		// The cached target still carries the URL from selection time; report the
		// page we just navigated to, not where the tab used to be.
		this.selectedTarget = { ...this.selectedTarget, url: input.url };
		return { created: false, target: this.selectedTarget };
	}

	/**
	 * Close a tab and return to a clean state. Closes the page with the given
	 * `targetId` (or the currently selected page when omitted), tears down its
	 * cached CDP connection (evictConn drops the socket + buffers), and -- if it
	 * was the selected page -- clears selectedTarget so the next navigate opens a
	 * fresh tab instead of reusing a dead one. This is the "finish the browser
	 * task and go back to the chat" step.
	 */
	async closePage(targetId?: string, signal?: AbortSignal): Promise<{ closedId: string }> {
		await this.ensureBrowser(signal);
		const id = targetId ?? this.selectedTarget?.id;
		if (!id) {
			throw new Error(
				"No page to close. Pass an id from chrome_devtools_list_pages, or select/navigate to one first.",
			);
		}
		await this.closeTargetImpl(id, signal);
		this.evictConn(id);
		if (this.selectedTarget?.id === id) this.selectedTarget = undefined;
		return { closedId: id };
	}

	async evaluate(
		expression: string,
		signal?: AbortSignal,
	): Promise<{ value?: unknown; description?: string; error?: string }> {
		const conn = await this.requireConn();
		const res = await conn.send(
			"Runtime.evaluate",
			{ expression, returnByValue: true, awaitPromise: true },
			{ signal },
		);
		if (res?.exceptionDetails) {
			// `text` is typically just "Uncaught"; the real message ("Error: boom")
			// lives in exception.description. Prefer the most informative field.
			const details = res.exceptionDetails;
			return { error: details.exception?.description ?? details.text ?? "Evaluation threw an exception." };
		}
		const r = res?.result ?? {};
		return { value: capEvaluateValue(r.value), description: r.description };
	}

	/**
	 * Click an element by CSS selector: scroll it into view, then dispatch real
	 * mouse press/release at its center so framework handlers (React/Vue) fire
	 * exactly like a user click.
	 */
	async click(selector: string, signal?: AbortSignal): Promise<void> {
		const conn = await this.requireConn();
		await this.ensureInputReady(conn, signal);
		const point = await this.elementCenter(conn, selector, signal);
		const base = { x: point.x, y: point.y, button: "left", clickCount: 1 };
		await conn.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base }, { signal });
		await conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base }, { signal });
	}

	/**
	 * Fill an input/textarea/contenteditable: focus it, select any existing
	 * content, then insert the text via Input.insertText (paste semantics —
	 * fires input events, replaces the selection, works with controlled inputs).
	 */
	async fill(selector: string, value: string, signal?: AbortSignal): Promise<void> {
		const conn = await this.requireConn();
		const focusExpr = `(() => {
			const el = document.querySelector(${JSON.stringify(selector)});
			if (!el) return false;
			el.scrollIntoView({ block: "center", inline: "center" });
			el.focus();
			if (typeof el.select === "function") el.select();
			else document.execCommand("selectAll", false, undefined);
			return true;
		})()`;
		const res = await conn.send("Runtime.evaluate", { expression: focusExpr, returnByValue: true }, { signal });
		if (!res?.result?.value) throw new Error(`No element matches selector ${JSON.stringify(selector)}.`);
		await this.ensureInputReady(conn, signal);
		await conn.send("Input.insertText", { text: value }, { signal });
	}

	/** Press a named key (Enter, Tab, …) or a single character on the focused element. */
	async pressKey(key: string, signal?: AbortSignal): Promise<void> {
		const conn = await this.requireConn();
		await this.ensureInputReady(conn, signal);
		const def = KEY_DEFS[key];
		if (!def) {
			if ([...key].length === 1) {
				await conn.send("Input.dispatchKeyEvent", { type: "char", text: key }, { signal });
				return;
			}
			throw new Error(
				`Unsupported key "${key}". Use one of: ${Object.keys(KEY_DEFS).join(", ")}, or a single character.`,
			);
		}
		const base = {
			key: def.key,
			code: def.code,
			windowsVirtualKeyCode: def.keyCode,
			nativeVirtualKeyCode: def.keyCode,
		};
		await conn.send(
			"Input.dispatchKeyEvent",
			{ type: "keyDown", ...base, ...(def.text ? { text: def.text } : {}) },
			{ signal },
		);
		await conn.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, { signal });
	}

	/** Visible text of the page (document.body.innerText). */
	async getPageText(signal?: AbortSignal): Promise<string> {
		const r = await this.evaluate('document.body ? document.body.innerText : ""', signal);
		if (r.error) throw new Error(r.error);
		return typeof r.value === "string" ? r.value : "";
	}

	/**
	 * Poll the page until a selector matches and is visible, or until the text
	 * appears in the body. Returns found=false on timeout instead of throwing so
	 * the tool can report it as a plain (non-exception) outcome.
	 */
	async waitFor(
		input: { selector?: string; text?: string; timeoutMs?: number },
		signal?: AbortSignal,
	): Promise<{ found: boolean; elapsedMs: number }> {
		if (!input.selector && !input.text) throw new Error("Provide a selector or text to wait for.");
		const conn = await this.requireConn();
		const checkExpr = input.selector
			? `(() => {
					const el = document.querySelector(${JSON.stringify(input.selector)});
					if (!el) return false;
					const r = el.getBoundingClientRect();
					return r.width > 0 && r.height > 0;
				})()`
			: `document.body ? document.body.innerText.includes(${JSON.stringify(input.text)}) : false`;
		const timeoutMs = Math.min(input.timeoutMs ?? WAIT_FOR_DEFAULT_TIMEOUT_MS, WAIT_FOR_MAX_TIMEOUT_MS);
		const startedAt = Date.now();
		for (;;) {
			if (signal?.aborted) throw new Error("waitFor aborted.");
			const res = await conn.send("Runtime.evaluate", { expression: checkExpr, returnByValue: true }, { signal });
			if (res?.result?.value === true) return { found: true, elapsedMs: Date.now() - startedAt };
			if (Date.now() - startedAt >= timeoutMs) return { found: false, elapsedMs: Date.now() - startedAt };
			await new Promise((r) => setTimeout(r, WAIT_FOR_POLL_MS));
		}
	}

	/** Hover an element by CSS selector (dispatches a real mouse move to its center). */
	async hover(selector: string, signal?: AbortSignal): Promise<void> {
		const conn = await this.requireConn();
		await this.ensureInputReady(conn, signal);
		const point = await this.elementCenter(conn, selector, signal);
		await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, { signal });
	}

	/**
	 * Select an option of a <select> by value, label or visible text, firing the
	 * input/change events frameworks listen to. Returns what was selected.
	 */
	async selectOption(
		selector: string,
		value: string,
		signal?: AbortSignal,
	): Promise<{ value: string; label: string }> {
		const conn = await this.requireConn();
		const expr = `(() => {
			const el = document.querySelector(${JSON.stringify(selector)});
			if (!el) return { error: "no-element" };
			if (!(el instanceof HTMLSelectElement)) return { error: "not-select" };
			const want = ${JSON.stringify(value)};
			const opts = Array.from(el.options);
			const opt = opts.find((o) => o.value === want) ?? opts.find((o) => o.label === want || (o.textContent ?? "").trim() === want);
			if (!opt) return { error: "no-option", options: opts.map((o) => o.value) };
			el.value = opt.value;
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
			return { value: opt.value, label: opt.label };
		})()`;
		const res = await conn.send("Runtime.evaluate", { expression: expr, returnByValue: true }, { signal });
		const v = res?.result?.value as
			| { error?: string; options?: string[]; value?: string; label?: string }
			| null
			| undefined;
		if (!v || v.error === "no-element") throw new Error(`No element matches selector ${JSON.stringify(selector)}.`);
		if (v.error === "not-select") throw new Error(`${JSON.stringify(selector)} is not a <select> element.`);
		if (v.error === "no-option") {
			throw new Error(`No option ${JSON.stringify(value)}. Available values: ${(v.options ?? []).join(", ")}`);
		}
		return { value: v.value ?? "", label: v.label ?? "" };
	}

	/** Set the files of an <input type="file"> (absolute paths, validated locally). */
	async uploadFile(selector: string, files: string[], signal?: AbortSignal): Promise<void> {
		for (const f of files) {
			if (!existsSync(f)) throw new Error(`File not found: ${f}`);
		}
		const conn = await this.requireConn();
		const nodeId = await this.domNodeId(conn, selector, signal);
		await conn.send("DOM.setFileInputFiles", { files, nodeId }, { signal });
	}

	/**
	 * Element → source: resolve the event-listener handlers bound to the element
	 * matching `selector` to their position in the ORIGINAL source (file:line) via
	 * CDP getEventListeners + source maps. Degrades to the transpiled position when
	 * no dev source map is present (mapped:false). See core/chrome/element-to-source.ts.
	 */
	async elementToSource(selector: string, signal?: AbortSignal): Promise<ElementToSourceResult> {
		const conn = await this.requireConn();
		return resolveElementToSource({ send: (m, p, o) => conn.send(m, p, o), signal }, selector);
	}

	/** DOM nodeId of the first element matching the selector. */
	private async domNodeId(conn: CdpConnectionLike, selector: string, signal?: AbortSignal): Promise<number> {
		const doc = await conn.send("DOM.getDocument", { depth: 1 }, { signal });
		const rootId = doc?.root?.nodeId;
		if (typeof rootId !== "number") throw new Error("Could not resolve the document root.");
		const q = await conn.send("DOM.querySelector", { nodeId: rootId, selector }, { signal });
		if (!q?.nodeId) throw new Error(`No element matches selector ${JSON.stringify(selector)}.`);
		return q.nodeId;
	}

	/**
	 * Accessibility-tree snapshot of the selected page: one "role \"name\"" line
	 * per interesting node, indented by depth. Far cheaper than a screenshot for
	 * understanding page structure, and gives the model stable click targets.
	 */
	async a11ySnapshot(selector?: string, signal?: AbortSignal): Promise<string> {
		const conn = await this.requireConn();
		try {
			await conn.send("Accessibility.enable", {}, { signal });
		} catch {
			// Optional domain on some target types; getFullAXTree may still work.
		}
		const res = await conn.send("Accessibility.getFullAXTree", {}, { signal });
		const nodes = (res?.nodes ?? []) as Array<{
			nodeId: string;
			ignored?: boolean;
			role?: { value?: string };
			name?: { value?: string };
			value?: { value?: unknown };
			childIds?: string[];
			parentId?: string;
			backendDOMNodeId?: number;
		}>;
		if (nodes.length === 0) return "(empty accessibility tree)";
		const byId = new Map(nodes.map((n) => [n.nodeId, n]));
		let root = nodes.find((n) => n.parentId === undefined) ?? nodes[0];
		if (selector) {
			// Scope to the subtree of the matching element: resolve its backend DOM
			// node id and find the AX node that wraps it. Keeps big pages within the
			// line cap instead of truncating the part the caller cares about.
			const nodeId = await this.domNodeId(conn, selector, signal);
			const desc = await conn.send("DOM.describeNode", { nodeId }, { signal });
			const backendId = desc?.node?.backendNodeId;
			const scoped = typeof backendId === "number" ? nodes.find((n) => n.backendDOMNodeId === backendId) : undefined;
			if (!scoped) {
				throw new Error(
					`${JSON.stringify(selector)} has no accessibility node (it may be ignored by the a11y tree).`,
				);
			}
			root = scoped;
		}
		type AxNode = (typeof nodes)[number];
		// Unnamed generic wrappers add depth without information — flatten them.
		const isBoring = (node: AxNode) => {
			const role = node.role?.value ?? "";
			const name = node.name?.value ?? "";
			return !!node.ignored || ((role === "generic" || role === "none" || role === "") && !name);
		};
		const renderLine = (node: AxNode, depth: number) => {
			const role = node.role?.value ?? "";
			const name = node.name?.value ?? "";
			const value = node.value?.value;
			const suffix = value !== undefined && value !== "" ? ` = ${JSON.stringify(value)}` : "";
			return `${"  ".repeat(depth)}${role}${name ? ` ${JSON.stringify(name)}` : ""}${suffix}`;
		};
		const lines: string[] = [];
		let startDepth = 0;
		if (selector) {
			// Breadcrumb: render the ancestors of the scoped node (one line each) so
			// the caller still sees WHERE in the page this region lives.
			const ancestors: AxNode[] = [];
			let cursor = root.parentId !== undefined ? byId.get(root.parentId) : undefined;
			while (cursor) {
				ancestors.unshift(cursor);
				cursor = cursor.parentId !== undefined ? byId.get(cursor.parentId) : undefined;
			}
			for (const ancestor of ancestors) {
				if (isBoring(ancestor)) continue;
				lines.push(renderLine(ancestor, startDepth));
				startDepth += 1;
			}
		}
		const visit = (id: string, depth: number) => {
			if (lines.length >= A11Y_SNAPSHOT_MAX_LINES) return;
			const node = byId.get(id);
			if (!node) return;
			let nextDepth = depth;
			if (!isBoring(node)) {
				lines.push(renderLine(node, depth));
				nextDepth = depth + 1;
			}
			for (const childId of node.childIds ?? []) visit(childId, nextDepth);
		};
		visit(root.nodeId, startDepth);
		if (lines.length >= A11Y_SNAPSHOT_MAX_LINES) lines.push(`… [truncated at ${A11Y_SNAPSHOT_MAX_LINES} lines]`);
		return lines.join("\n");
	}

	/**
	 * Response body of a buffered network request (see readNetwork for ids).
	 * Returns the proactively cached snapshot when present (the common path — CDP
	 * would otherwise have evicted it), falling back to a live CDP fetch for bodies
	 * we did not cache (binary assets, oversized bodies, scripts/styles).
	 */
	async getResponseBody(requestId: string, signal?: AbortSignal): Promise<{ body: string; base64Encoded: boolean }> {
		const state = this.requireState();
		const cached = state.bodies.get(requestId);
		if (cached) {
			return {
				body: capPayload(cached.body, MAX_CDP_BODY_BYTES, "chrome.getResponseBody"),
				base64Encoded: cached.base64Encoded,
			};
		}
		const conn = await this.requireConn();
		try {
			const res = await conn.send("Network.getResponseBody", { requestId }, { signal });
			// CDP returns the whole body; cap it so a giant asset isn't retained or
			// propagated to the rest of the pipeline (tool result, render, compaction).
			const raw = typeof res?.body === "string" ? res.body : "";
			const capped = capPayload(raw, MAX_CDP_BODY_BYTES, "chrome.getResponseBody");
			return {
				body: res?.base64Encoded ? capped : redactHttpBody(capped),
				base64Encoded: !!res?.base64Encoded,
			};
		} catch (err) {
			throw new Error(
				`Could not read body for request ${requestId}: ${(err as Error).message}. ` +
					"Chrome may have evicted it — re-trigger the request and read it again.",
			);
		}
	}

	/**
	 * Snapshot a text-ish response body on Network.loadingFinished so it survives
	 * CDP's own buffer eviction. Fire-and-forget from the event handler; never
	 * throws out of the event loop. Skips bodies already cached, non-text MIME
	 * types, binary payloads, and bodies over the per-entry cap (left to a live
	 * fetch). Enforces the total budget with FIFO eviction.
	 */
	private async cacheBody(conn: CdpConnectionLike, state: ConnState, requestId: string | undefined): Promise<void> {
		if (!requestId || state.bodies.has(requestId)) return;
		const entry = state.networkById.get(requestId);
		if (!entry || !isCacheableMime(entry.mimeType ?? "")) return;
		if (conn.isClosed?.()) return;
		try {
			const res = await conn.send("Network.getResponseBody", { requestId });
			if (res?.base64Encoded) return;
			const rawBody = typeof res?.body === "string" ? res.body : "";
			if (rawBody.length === 0) return;
			const bounded = boundedText(redactHttpBody(rawBody), BODY_CACHE_PER_ENTRY);
			// A late event for a request already dropped from the ring would leak its
			// bytes (no eviction ever reclaims them), so only cache what's still buffered.
			if (!state.networkById.has(requestId)) return;
			state.bodies.set(requestId, {
				body: bounded.text,
				base64Encoded: false,
				bytes: bounded.bytes,
				truncated: bounded.truncated,
			});
			entry.responseBody = bounded.text;
			entry.responseBodyTruncated = bounded.truncated;
			state.bodyBytes += bounded.bytes;
			while (state.bodyBytes > BODY_CACHE_BUDGET) {
				const oldest = state.bodies.keys().next();
				if (oldest.done) break;
				this.dropCachedBody(state, oldest.value);
			}
		} catch {
			// No body for this request (redirect / 204 / already gone) — ignore.
		}
	}

	private async captureRequestPostData(conn: CdpConnectionLike, state: ConnState, requestId: string): Promise<void> {
		try {
			const response = await conn.send("Network.getRequestPostData", { requestId });
			const entry = state.networkById.get(requestId);
			if (!entry || typeof response?.postData !== "string") return;
			const bounded = boundedText(redactHttpBody(response.postData), REQUEST_BODY_PER_ENTRY);
			entry.requestBody = bounded.text;
			entry.requestBodyTruncated = bounded.truncated;
		} catch {
			// CDP does not retain post data for every request; the event body is preferred.
		}
	}

	/** Remove a cached body and reclaim its bytes from the running total. */
	private dropCachedBody(state: ConnState, requestId: string): void {
		const hit = state.bodies.get(requestId);
		if (!hit) return;
		state.bodies.delete(requestId);
		state.bodyBytes -= hit.bytes;
	}

	/**
	 * Wait, once per connection, until the renderer can actually receive synthetic
	 * input. A freshly launched or just-navigated page answers Runtime.evaluate
	 * (DOM parsed) before its compositor has produced a frame, and Chrome silently
	 * drops the Input.dispatch / insertText events that land in that gap -- so the first
	 * fill/click/pressKey would no-op. Two chained requestAnimationFrame callbacks
	 * resolve only after a frame has been composited, which is exactly the point
	 * the input pipeline starts delivering events. Memoized on the ConnState so the
	 * cost is paid once; on a warm page it resolves in ~one frame. Capped + fail-
	 * open so a stuck rAF (background/throttled tab) can never block an action.
	 */
	private async ensureInputReady(conn: CdpConnectionLike, signal?: AbortSignal): Promise<void> {
		const id = this.selectedTarget?.id;
		const state = id ? this.conns.get(id) : undefined;
		if (state?.inputReady) return state.inputReady;
		const gate = (async () => {
			const expr = "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))";
			try {
				await conn.send(
					"Runtime.evaluate",
					{ expression: expr, awaitPromise: true, returnByValue: true },
					{ signal, timeoutMs: INPUT_READY_MAX_MS },
				);
			} catch {
				// rAF never fired (throttled/background tab) or timed out — don't block
				// the interaction. A best-effort short settle keeps the common cold-start
				// case working; the action proceeds either way.
				await new Promise((r) => setTimeout(r, 100));
			}
		})();
		if (state) state.inputReady = gate;
		return gate;
	}

	private async elementCenter(
		conn: CdpConnectionLike,
		selector: string,
		signal?: AbortSignal,
	): Promise<{ x: number; y: number }> {
		const expr = `(() => {
			const el = document.querySelector(${JSON.stringify(selector)});
			if (!el) return null;
			el.scrollIntoView({ block: "center", inline: "center" });
			const r = el.getBoundingClientRect();
			return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
		})()`;
		const res = await conn.send("Runtime.evaluate", { expression: expr, returnByValue: true }, { signal });
		const v = res?.result?.value as { x: number; y: number } | null | undefined;
		if (!v) throw new Error(`No element matches selector ${JSON.stringify(selector)}.`);
		return v;
	}

	async screenshot(input: { fullPage?: boolean }, signal?: AbortSignal): Promise<string> {
		const conn = await this.requireConn();
		const res = await conn.send(
			"Page.captureScreenshot",
			{ format: "png", captureBeyondViewport: !!input.fullPage },
			{ signal },
		);
		if (typeof res?.data !== "string") throw new Error("Screenshot returned no data.");
		return res.data;
	}

	readConsole(input: { limit?: number; level?: string }): ConsoleLine[] {
		const state = this.requireState();
		let lines = state.console;
		if (input.level) lines = lines.filter((l) => l.level === input.level);
		const limit = input.limit ?? 50;
		return limit <= 0 ? [] : lines.slice(-limit);
	}

	/**
	 * Buffered network requests, newest last. Filters (urlPattern / method / type /
	 * status) narrow the FULL buffer before the limit is applied, so a small limit
	 * still returns the matching requests rather than the last N of everything (the
	 * usual case: the real API call drowned in tracking/pixel noise).
	 */
	readNetwork(input: {
		limit?: number;
		urlPattern?: string;
		method?: string;
		type?: string;
		status?: string | number;
	}): NetworkEntry[] {
		const state = this.requireState();
		let entries = state.network;
		if (input.urlPattern) {
			const needle = input.urlPattern.toLowerCase();
			entries = entries.filter((e) => e.url.toLowerCase().includes(needle));
		}
		if (input.method) {
			const m = input.method.toLowerCase();
			entries = entries.filter((e) => e.method.toLowerCase() === m);
		}
		if (input.type) {
			const t = input.type.toLowerCase();
			entries = entries.filter((e) => (e.resourceType ?? "").toLowerCase() === t);
		}
		if (input.status !== undefined) {
			const matches = statusMatcher(input.status);
			entries = entries.filter((e) => e.status !== undefined && matches(e.status));
		}
		const limit = input.limit ?? 50;
		return limit <= 0 ? [] : entries.slice(-limit);
	}

	/** Resolve one buffered redirect hop. Omitting hop returns the latest hop. */
	getNetworkEntry(requestId: string, hop?: number): NetworkEntry {
		const state = this.requireState();
		const entry =
			hop === undefined ? state.networkById.get(requestId) : state.networkByEntryId.get(`${requestId}#${hop}`);
		if (!entry) {
			throw new Error(
				`No buffered network request ${requestId}${hop === undefined ? "" : ` hop ${hop}`}. Re-trigger it and read the network buffer again.`,
			);
		}
		return entry;
	}

	async replayCapturedXhr(
		requestId: string,
		hop?: number,
		patch?: CapturedXhrPatch,
		signal?: AbortSignal,
		timeoutMs = 15_000,
	): Promise<NetworkEntry> {
		const source = this.getNetworkEntry(requestId, hop);
		if (source.resourceType?.toLowerCase() !== "xhr") {
			throw new Error("Only captured XHR requests can be replayed through Chrome DevTools.");
		}
		const state = this.requireState();
		const conn = await this.requireConn();
		const existing = new Set(state.network.map((entry) => entry.entryId));
		const boundedTimeout = Math.max(1, Math.min(60_000, timeoutMs));
		const deadline = Date.now() + boundedTimeout;
		const shouldPatch = patch?.body !== undefined || Object.keys(patch?.headers ?? {}).length > 0;
		let fetchEnabled = false;
		let stopFetch = () => {};

		try {
			if (shouldPatch) {
				let patched = false;
				stopFetch = conn.on("Fetch.requestPaused", (event) => {
					const pausedId = typeof event?.requestId === "string" ? event.requestId : undefined;
					if (!pausedId) return;
					const pausedMethod = typeof event?.request?.method === "string" ? event.request.method : "GET";
					const pausedUrl = typeof event?.request?.url === "string" ? event.request.url : "";
					const isReplay = !patched && pausedMethod === source.method && redactHttpUrl(pausedUrl) === source.url;
					if (!isReplay) {
						void conn.send("Fetch.continueRequest", { requestId: pausedId }).catch(() => {});
						return;
					}
					patched = true;
					const headers = new Map<string, { name: string; value: string }>();
					for (const [name, value] of Object.entries(event?.request?.headers ?? {})) {
						if (typeof value === "string") headers.set(name.toLowerCase(), { name, value });
					}
					for (const [name, value] of Object.entries(patch?.headers ?? {})) {
						headers.set(name.toLowerCase(), { name, value });
					}
					void conn
						.send("Fetch.continueRequest", {
							requestId: pausedId,
							headers: [...headers.values()],
							...(patch?.body !== undefined
								? { postData: Buffer.from(patch.body, "utf8").toString("base64") }
								: {}),
						})
						.catch(() => {});
				});
				await conn.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, { signal });
				fetchEnabled = true;
			}

			await conn.send("Network.replayXHR", { requestId: source.requestId }, { signal });
			for (;;) {
				if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
				const replay = state.network.find(
					(entry) =>
						!existing.has(entry.entryId) &&
						entry.resourceType?.toLowerCase() === "xhr" &&
						entry.method === source.method &&
						entry.url === source.url,
				);
				if (replay && (replay.durationMs !== undefined || replay.failureText !== undefined || replay.canceled)) {
					if (replay.responseBody === undefined) {
						try {
							const response = await this.getResponseBody(replay.requestId, signal);
							if (!response.base64Encoded) {
								const bounded = boundedText(response.body, BODY_CACHE_PER_ENTRY);
								replay.responseBody = bounded.text;
								replay.responseBodyTruncated = bounded.truncated;
							}
						} catch {
							// Redirects and empty responses may not expose a body.
						}
					}
					return replay;
				}
				if (Date.now() >= deadline) {
					throw new Error(`Captured XHR replay timed out after ${boundedTimeout}ms`);
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		} finally {
			if (fetchEnabled) {
				await conn.send("Fetch.disable", {}, { timeoutMs: 2_000 }).catch(() => {});
			}
			stopFetch();
		}
	}

	dispose(): void {
		for (const [, state] of this.conns) {
			for (const u of state.unsubs) u();
			try {
				state.conn.close();
			} catch {
				// ignore
			}
		}
		this.conns.clear();
		this.connecting.clear();
		this.selectedTarget = undefined;
	}

	private async requireConn(): Promise<CdpConnectionLike> {
		if (!this.selectedTarget) {
			throw new Error("No page selected. Use chrome_devtools_navigate or chrome_devtools_select_page first.");
		}
		return this.getConn(this.selectedTarget);
	}

	private requireState(): ConnState {
		const id = this.selectedTarget?.id;
		const state = id ? this.conns.get(id) : undefined;
		if (!state) {
			throw new Error("No page selected. Use chrome_devtools_navigate or chrome_devtools_select_page first.");
		}
		return state;
	}

	private async getConn(target: CdpTarget): Promise<CdpConnectionLike> {
		const existing = this.conns.get(target.id);
		if (existing) {
			// A CDP socket that dropped (tab closed, Chrome restarted, transient WS
			// error) never recovers — every send() throws "CDP connection is
			// closed." forever. Evict it so this call reconnects instead of handing
			// back a permanently broken page.
			if (existing.conn.isClosed?.()) this.evictConn(target.id);
			else return existing.conn;
		}
		// Dedup concurrent opens for the same target: the first caller starts the
		// connection, later callers await the same promise instead of opening a
		// second socket that would orphan the first (unsubscribed, never closed).
		const inFlight = this.connecting.get(target.id);
		if (inFlight) return inFlight;
		const pending = this.openConn(target).finally(() => this.connecting.delete(target.id));
		this.connecting.set(target.id, pending);
		return pending;
	}

	private evictConn(targetId: string): void {
		const state = this.conns.get(targetId);
		if (!state) return;
		for (const u of state.unsubs) u();
		try {
			state.conn.close();
		} catch {
			// ignore
		}
		this.conns.delete(targetId);
	}

	private pushNetworkEntry(state: ConnState, entry: NetworkEntry): void {
		state.network.push(entry);
		state.networkById.set(entry.requestId, entry);
		state.networkByEntryId.set(entry.entryId, entry);
		if (state.network.length > BUFFER_MAX) {
			const removed = state.network.shift();
			if (removed) {
				if (state.networkById.get(removed.requestId) === removed) state.networkById.delete(removed.requestId);
				state.networkByEntryId.delete(removed.entryId);
				state.requestExtraAssigned.delete(removed.entryId);
				state.responseExtraAssigned.delete(removed.entryId);
				this.dropCachedBody(state, removed.requestId);
			}
		}
	}

	private applyRequestExtra(state: ConnState, entry: NetworkEntry, extra: any): void {
		entry.requestHeaders = redactHttpHeaders(extra?.headers ?? {});
		entry.requestHeadersSource = "extra-info";
		entry.associatedCookies = cookieSummaries(extra?.associatedCookies);
		state.requestExtraAssigned.add(entry.entryId);
	}

	private applyResponseExtra(state: ConnState, entry: NetworkEntry, extra: any): void {
		entry.responseHeaders = redactHttpHeaders(extra?.headers ?? {});
		entry.responseHeadersSource = "extra-info";
		if (typeof extra?.statusCode === "number") entry.status = extra.statusCode;
		entry.blockedResponseCookies = blockedCookieSummaries(extra?.blockedCookies);
		state.responseExtraAssigned.add(entry.entryId);
	}

	private assignExtraInfo(state: ConnState, requestId: string, extra: any, kind: "request" | "response"): void {
		const assigned = kind === "request" ? state.requestExtraAssigned : state.responseExtraAssigned;
		const entry = state.network.find(
			(candidate) => candidate.requestId === requestId && !assigned.has(candidate.entryId),
		);
		if (entry) {
			if (kind === "request") this.applyRequestExtra(state, entry, extra);
			else this.applyResponseExtra(state, entry, extra);
			return;
		}
		const pending = kind === "request" ? state.pendingRequestExtra : state.pendingResponseExtra;
		const queue = pending.get(requestId) ?? [];
		queue.push(extra);
		pending.set(requestId, queue);
	}

	private async openConn(target: CdpTarget): Promise<CdpConnectionLike> {
		const conn = this.connectFactory(target);
		const state: ConnState = {
			conn,
			console: [],
			network: [],
			networkById: new Map(),
			networkByEntryId: new Map(),
			requestExtraAssigned: new Set(),
			responseExtraAssigned: new Set(),
			pendingRequestExtra: new Map(),
			pendingResponseExtra: new Map(),
			bodies: new Map(),
			bodyBytes: 0,
			unsubs: [],
		};
		this.conns.set(target.id, state);

		const pushConsole = (line: ConsoleLine) => {
			state.console.push(line);
			if (state.console.length > BUFFER_MAX) state.console.shift();
		};
		state.unsubs.push(
			conn.on("Runtime.consoleAPICalled", (p) =>
				pushConsole({ level: p?.type ?? "log", text: remoteArgsToText(p?.args) }),
			),
			conn.on("Log.entryAdded", (p) =>
				pushConsole({ level: p?.entry?.level ?? "info", text: p?.entry?.text ?? "" }),
			),
			conn.on("Network.requestWillBeSent", (p) => {
				if (typeof p?.requestId !== "string") return;
				const previous = state.networkById.get(p.requestId);
				const hop = previous ? previous.hop + 1 : 0;
				const entryId = `${p.requestId}#${hop}`;
				if (previous && p?.redirectResponse) {
					if (!state.responseExtraAssigned.has(previous.entryId)) {
						previous.responseHeaders = redactHttpHeaders(p.redirectResponse.headers ?? {});
						previous.responseHeadersSource = "response";
					}
					if (typeof p.redirectResponse.status === "number") previous.status = p.redirectResponse.status;
					if (typeof p.redirectResponse.mimeType === "string") previous.mimeType = p.redirectResponse.mimeType;
					if (typeof p.redirectResponse.protocol === "string") previous.protocol = p.redirectResponse.protocol;
					previous.timing = numericTiming(p.redirectResponse.timing);
					previous.redirectToEntryId = entryId;
				}
				const rawPostData = typeof p?.request?.postData === "string" ? p.request.postData : undefined;
				const postData = rawPostData ? boundedText(redactHttpBody(rawPostData), REQUEST_BODY_PER_ENTRY) : undefined;
				const entry: NetworkEntry = {
					entryId,
					requestId: p?.requestId,
					hop,
					method: p?.request?.method ?? "GET",
					url: redactHttpUrl(p?.request?.url ?? ""),
					requestHeaders: redactHttpHeaders(p?.request?.headers ?? {}),
					requestHeadersSource: "request",
					...(postData ? { requestBody: postData.text, requestBodyTruncated: postData.truncated } : {}),
					...(typeof p?.timestamp === "number" ? { startedAtMs: p.timestamp * 1000 } : {}),
					...(typeof p?.wallTime === "number" ? { wallTimeMs: p.wallTime * 1000 } : {}),
					...(p?.type ? { resourceType: p.type } : {}),
					...(previous && p?.redirectResponse ? { redirectFromEntryId: previous.entryId } : {}),
					...(p?.initiator ? { initiator: initiatorSummary(p.initiator) } : {}),
				};
				this.pushNetworkEntry(state, entry);
				const pendingRequest = state.pendingRequestExtra.get(p.requestId)?.shift();
				if (pendingRequest) this.applyRequestExtra(state, entry, pendingRequest);
				if (state.pendingRequestExtra.get(p.requestId)?.length === 0) state.pendingRequestExtra.delete(p.requestId);
				const pendingResponse = state.pendingResponseExtra.get(p.requestId)?.shift();
				if (pendingResponse) this.applyResponseExtra(state, entry, pendingResponse);
				if (state.pendingResponseExtra.get(p.requestId)?.length === 0)
					state.pendingResponseExtra.delete(p.requestId);
				if (!postData && p?.request?.hasPostData && typeof p?.requestId === "string") {
					void this.captureRequestPostData(conn, state, p.requestId);
				}
			}),
			conn.on("Network.requestWillBeSentExtraInfo", (p) => {
				if (typeof p?.requestId === "string") this.assignExtraInfo(state, p.requestId, p, "request");
			}),
			conn.on("Network.responseReceivedExtraInfo", (p) => {
				if (typeof p?.requestId === "string") this.assignExtraInfo(state, p.requestId, p, "response");
			}),
			conn.on("Network.responseReceived", (p) => {
				const entry = state.networkById.get(p?.requestId);
				if (entry) {
					entry.status = p?.response?.status;
					entry.mimeType = p?.response?.mimeType;
					if (!state.responseExtraAssigned.has(entry.entryId)) {
						entry.responseHeaders = redactHttpHeaders(p?.response?.headers ?? {});
						entry.responseHeadersSource = "response";
					}
					if (typeof p?.response?.protocol === "string") entry.protocol = p.response.protocol;
					entry.timing = numericTiming(p?.response?.timing);
					if (p?.type) entry.resourceType = p.type;
				}
			}),
			// Snapshot text-ish bodies the moment they finish, before CDP evicts them
			// from its own buffer. Fire-and-forget — cacheBody swallows its own errors.
			conn.on("Network.loadingFinished", (p) => {
				const entry = state.networkById.get(p?.requestId);
				if (entry) {
					if (typeof p?.timestamp === "number" && typeof entry.startedAtMs === "number") {
						entry.durationMs = Math.max(0, p.timestamp * 1000 - entry.startedAtMs);
					}
					if (typeof p?.encodedDataLength === "number") entry.encodedDataLength = p.encodedDataLength;
				}
				void this.cacheBody(conn, state, p?.requestId);
			}),
			conn.on("Network.loadingFailed", (p) => {
				const entry = state.networkById.get(p?.requestId);
				if (!entry) return;
				if (typeof p?.timestamp === "number" && typeof entry.startedAtMs === "number") {
					entry.durationMs = Math.max(0, p.timestamp * 1000 - entry.startedAtMs);
				}
				if (typeof p?.errorText === "string") entry.failureText = redactHttpBody(p.errorText);
				entry.canceled = !!p?.canceled;
			}),
			// A JS dialog (alert/confirm/prompt/beforeunload) blocks the renderer: every
			// subsequent CDP command stalls until the per-command 30s timeout, repeatedly.
			// Auto-dismiss so the renderer unblocks and following commands resolve. Fire-
			// and-forget — never throw out of the event loop.
			conn.on("Page.javascriptDialogOpening", () => {
				conn.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
			}),
		);

		// Enable the domains we buffer + need; tolerate individual failures. Network
		// gets enlarged buffers so a body we did not proactively cache still survives
		// a live getResponseBody fetch on a busy page.
		await Promise.allSettled(
			(["Page", "Runtime", "Log", "Network"] as const).map(async (domain) => {
				const params =
					domain === "Network"
						? {
								maxTotalBufferSize: NETWORK_TOTAL_BUFFER_BYTES,
								maxResourceBufferSize: NETWORK_RESOURCE_BUFFER_BYTES,
							}
						: {};
				await conn.send(`${domain}.enable`, params);
			}),
		);
		return conn;
	}
}

// ---------------------------------------------------------------------------
// Module-level registry (mirrors goal-manager / todo-manager / preview-queue).
// ---------------------------------------------------------------------------

let currentManager: ChromeDevtoolsManager | undefined;

export function setCurrentChromeDevtoolsManager(mgr: ChromeDevtoolsManager | undefined): void {
	currentManager = mgr;
}

export function getCurrentChromeDevtoolsManager(): ChromeDevtoolsManager | undefined {
	return currentManager;
}
