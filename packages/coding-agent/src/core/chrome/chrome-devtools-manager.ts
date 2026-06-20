/**
 * ChromeDevtoolsManager — session-scoped state for the chrome_devtools_* tools.
 *
 * Holds the resolved endpoint (host/port), a cache of CDP connections keyed by
 * targetId, the currently selected page, and ring buffers of console/network
 * events per connection. Connects to a reachable Chrome (started with
 * --remote-debugging-port) and can open a NEW tab via the DevTools HTTP
 * endpoint. When `launchBrowser` is set (the default), it auto-launches Chrome
 * into a dedicated persistent profile if the debug port is unreachable;
 * otherwise it only attaches to an already-running instance. Published via a
 * module-level registry (mirrors goal/todo/preview-queue).
 */

import { existsSync } from "node:fs";
import { recordDiagnostic } from "@pit/ai";
import { sliceSafe } from "../../utils/surrogate.ts";
import {
	CdpConnection,
	type CdpTarget,
	closeTarget as defaultCloseTarget,
	createTarget as defaultCreateTarget,
	listTargets as defaultListTargets,
} from "./cdp-client.ts";
import { findChromeBinary, launchChrome, waitForEndpoint } from "./chrome-launcher.ts";
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
	requestId: string;
	method: string;
	url: string;
	status?: number;
	mimeType?: string;
	/** CDP resource type (Document/Script/XHR/Fetch/Image/Font/…) — used by readNetwork filters. */
	resourceType?: string;
}

export interface ChromeDevtoolsDeps {
	host: string;
	port: number;
	/** Auto-launch Chrome when the debug port is not reachable. */
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
	waitReady?: (host: string, port: number) => Promise<boolean>;
}

interface ConnState {
	conn: CdpConnectionLike;
	console: ConsoleLine[];
	network: NetworkEntry[];
	// Proactively captured response bodies, keyed by requestId. CDP evicts bodies
	// from its own buffer as new requests pile up (and on navigation), so a body
	// fetched lazily by getResponseBody is often already gone. We snapshot text-ish
	// bodies on Network.loadingFinished instead, so they stay readable for the page's
	// lifetime. Bounded by BODY_CACHE_BUDGET (total) + BODY_CACHE_PER_ENTRY (each).
	bodies: Map<string, { body: string; base64Encoded: boolean; bytes: number }>;
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
	private readonly port: number;
	private readonly list: (signal?: AbortSignal) => Promise<CdpTarget[]>;
	private readonly create: (url: string, signal?: AbortSignal) => Promise<CdpTarget>;
	private readonly closeTargetImpl: (id: string, signal?: AbortSignal) => Promise<void>;
	private readonly connectFactory: (target: CdpTarget) => CdpConnectionLike;
	private readonly launchBrowser: boolean;
	private readonly userDataDir: string;
	private readonly binaryPath: string | undefined;
	private readonly findBinary: () => string | undefined;
	private readonly launch: (opts: { binary: string; port: number; userDataDir: string }) => void;
	private readonly waitReady: (host: string, port: number) => Promise<boolean>;

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
		this.waitReady = deps.waitReady ?? ((host, port) => waitForEndpoint(host, port));
	}

	/**
	 * Make sure a Chrome with the debug port is reachable: reconnect if one is
	 * already up, otherwise auto-launch (when enabled). Idempotent — concurrent
	 * callers share one ensure. Returns whether a browser was launched.
	 */
	async ensureBrowser(signal?: AbortSignal): Promise<{ launched: boolean }> {
		if (this.ensurePromise) return this.ensurePromise;
		this.ensurePromise = this.doEnsure(signal).finally(() => {
			this.ensurePromise = undefined;
		});
		return this.ensurePromise;
	}

	private async doEnsure(signal?: AbortSignal): Promise<{ launched: boolean }> {
		if (await this.reachable(signal)) return { launched: false };
		if (!this.launchBrowser) {
			// Surface the standard "start Chrome / unreachable" error.
			await this.list(signal);
			return { launched: false };
		}
		const binary = this.binaryPath || this.findBinary();
		if (!binary) {
			throw new Error(
				"Chrome was not found. Install Chrome, or set chromeDevtools.binaryPath / PIT_CHROME_DEVTOOLS_BINARY.",
			);
		}
		this.launch({ binary, port: this.port, userDataDir: this.userDataDir });
		const ready = await this.waitReady(this.host, this.port);
		if (!ready) {
			throw new Error(`Launched Chrome but the debug port ${this.port} did not open in time.`);
		}
		this.launchedHere = true;
		return { launched: true };
	}

	private async reachable(signal?: AbortSignal): Promise<boolean> {
		try {
			await this.list(signal);
			return true;
		} catch {
			return false;
		}
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
		if (state) state.inputReady = undefined;
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
			return {
				body: capPayload(raw, MAX_CDP_BODY_BYTES, "chrome.getResponseBody"),
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
		const entry = state.network.find((e) => e.requestId === requestId);
		if (!entry || !isCacheableMime(entry.mimeType ?? "")) return;
		if (conn.isClosed?.()) return;
		try {
			const res = await conn.send("Network.getResponseBody", { requestId });
			if (res?.base64Encoded) return;
			const body = typeof res?.body === "string" ? res.body : "";
			const bytes = body.length;
			if (bytes === 0 || bytes > BODY_CACHE_PER_ENTRY) return;
			// A late event for a request already dropped from the ring would leak its
			// bytes (no eviction ever reclaims them), so only cache what's still buffered.
			if (!state.network.some((e) => e.requestId === requestId)) return;
			state.bodies.set(requestId, { body, base64Encoded: false, bytes });
			state.bodyBytes += bytes;
			while (state.bodyBytes > BODY_CACHE_BUDGET) {
				const oldest = state.bodies.keys().next();
				if (oldest.done) break;
				this.dropCachedBody(state, oldest.value);
			}
		} catch {
			// No body for this request (redirect / 204 / already gone) — ignore.
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
		return lines.slice(-limit);
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
		return entries.slice(-(input.limit ?? 50));
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

	private async openConn(target: CdpTarget): Promise<CdpConnectionLike> {
		const conn = this.connectFactory(target);
		const state: ConnState = { conn, console: [], network: [], bodies: new Map(), bodyBytes: 0, unsubs: [] };
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
				state.network.push({
					requestId: p?.requestId,
					method: p?.request?.method ?? "GET",
					url: p?.request?.url ?? "",
					...(p?.type ? { resourceType: p.type } : {}),
				});
				if (state.network.length > BUFFER_MAX) {
					const removed = state.network.shift();
					// Drop the evicted request's cached body too, so the body cache can
					// never outlive its ring entry (and its bytes are reclaimed).
					if (removed) this.dropCachedBody(state, removed.requestId);
				}
			}),
			conn.on("Network.responseReceived", (p) => {
				const entry = state.network.find((e) => e.requestId === p?.requestId);
				if (entry) {
					entry.status = p?.response?.status;
					entry.mimeType = p?.response?.mimeType;
					if (p?.type) entry.resourceType = p.type;
				}
			}),
			// Snapshot text-ish bodies the moment they finish, before CDP evicts them
			// from its own buffer. Fire-and-forget — cacheBody swallows its own errors.
			conn.on("Network.loadingFinished", (p) => {
				void this.cacheBody(conn, state, p?.requestId);
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
		for (const domain of ["Page", "Runtime", "Log", "Network"]) {
			try {
				const params =
					domain === "Network"
						? {
								maxTotalBufferSize: NETWORK_TOTAL_BUFFER_BYTES,
								maxResourceBufferSize: NETWORK_RESOURCE_BUFFER_BYTES,
							}
						: {};
				await conn.send(`${domain}.enable`, params);
			} catch {
				// A domain may be unavailable for some target types; keep going.
			}
		}
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
