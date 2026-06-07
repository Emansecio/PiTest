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

import {
	CdpConnection,
	type CdpTarget,
	createTarget as defaultCreateTarget,
	listTargets as defaultListTargets,
} from "./cdp-client.ts";
import { findChromeBinary, launchChrome, waitForEndpoint } from "./chrome-launcher.ts";

export interface CdpConnectionLike {
	send(
		method: string,
		params?: Record<string, unknown>,
		opts?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<any>;
	on(eventMethod: string, handler: (params: any) => void): () => void;
	close(): void;
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
	unsubs: Array<() => void>;
}

const BUFFER_MAX = 200;

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
				"Chrome was not found. Install Chrome, or set chromeDevtools.binaryPath / PI_CHROME_DEVTOOLS_BINARY.",
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
		await conn.send("Page.navigate", { url: input.url }, { signal });
		return { created: false, target: this.selectedTarget };
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
			return { error: res.exceptionDetails.text ?? "Evaluation threw an exception." };
		}
		const r = res?.result ?? {};
		return { value: r.value, description: r.description };
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

	readNetwork(input: { limit?: number }): NetworkEntry[] {
		const state = this.requireState();
		return state.network.slice(-(input.limit ?? 50));
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
		if (existing) return existing.conn;
		// Dedup concurrent opens for the same target: the first caller starts the
		// connection, later callers await the same promise instead of opening a
		// second socket that would orphan the first (unsubscribed, never closed).
		const inFlight = this.connecting.get(target.id);
		if (inFlight) return inFlight;
		const pending = this.openConn(target).finally(() => this.connecting.delete(target.id));
		this.connecting.set(target.id, pending);
		return pending;
	}

	private async openConn(target: CdpTarget): Promise<CdpConnectionLike> {
		const conn = this.connectFactory(target);
		const state: ConnState = { conn, console: [], network: [], unsubs: [] };
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
				});
				if (state.network.length > BUFFER_MAX) state.network.shift();
			}),
			conn.on("Network.responseReceived", (p) => {
				const entry = state.network.find((e) => e.requestId === p?.requestId);
				if (entry) entry.status = p?.response?.status;
			}),
		);

		// Enable the domains we buffer + need; tolerate individual failures.
		for (const domain of ["Page", "Runtime", "Log", "Network"]) {
			try {
				await conn.send(`${domain}.enable`);
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
