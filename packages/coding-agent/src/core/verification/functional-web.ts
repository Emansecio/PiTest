/**
 * Native functional web Definition-of-Done check.
 *
 * Opens a local page (localhost or ephemeral preview server), validates a11y
 * structure, performs minimal safe interactions (clicks + non-destructive fill),
 * asserts URL/DOM state change when interacting, and fails on console errors /
 * network 4xx+. Fail-open absolute when Chrome is unavailable or the target
 * cannot be resolved — never blocks a non-web turn.
 *
 * Kill-switch: PIT_NO_FUNCTIONAL_WEB=1
 */

import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import type { ChromeDevtoolsManager } from "../chrome/chrome-devtools-manager.ts";
import type { ResolvedTarget } from "../preview/preview-server.ts";
import {
	type BackgroundJobLike,
	detectWebProject,
	isAllowedFunctionalWebUrl,
	resolveFunctionalWebUrl,
} from "./detect-web-target.ts";

const READY_TIMEOUT_MS = 8_000;
const READY_POLL_MS = 120;
const SETTLE_DEFAULT_MS = 400;
const DEFAULT_MAX_INTERACTIONS = 3;
const DEFAULT_TIMEOUT_MS = 45_000;

const DANGEROUS_NAME =
	/\b(delete|remove|destroy|logout|log out|sign out|pay|purchase|checkout|submit payment|unsubscribe|drop)\b/i;
const PASSWORD_HINT = /\b(password|passwd|secret|token|ssn|credit.?card|cvv)\b/i;

export type FunctionalWebStatus = "passed" | "failed" | "skipped";

export interface FunctionalWebFinding {
	phase: string;
	message: string;
}

export interface FunctionalWebResult {
	status: FunctionalWebStatus;
	url?: string;
	findings: FunctionalWebFinding[];
	/** Why the check was skipped (chrome_unavailable, not_web, no_url, kill_switch, …). */
	reason?: string;
	consoleErrors?: number;
	networkFailures?: number;
	interactionsAttempted?: number;
}

export interface FunctionalWebCheckOptions {
	cwd: string;
	mgr: ChromeDevtoolsManager | undefined;
	lastVisualFile?: string;
	touchedVisual: boolean;
	backgroundJobs?: BackgroundJobLike[];
	maxInteractions?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Injected for tests. */
	resolveUrl?: (input: {
		cwd: string;
		lastVisualFile?: string;
		backgroundJobs?: BackgroundJobLike[];
	}) => Promise<ResolvedTarget | null>;
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

async function settle(mgr: ChromeDevtoolsManager, extraMs: number, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (signal?.aborted) return;
		const r = await mgr.evaluate("document.readyState", signal);
		if (r.value === "complete" || r.description === "complete") break;
		await delay(READY_POLL_MS, signal);
	}
	await delay(Math.max(0, extraMs), signal);
}

export function isFunctionalWebDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_NO_FUNCTIONAL_WEB);
}

/** Build the fix prompt re-injected into the agent when the functional check fails. */
export function functionalWebFixPrompt(result: FunctionalWebResult): string {
	const lines = [
		"The change isn't functionally verified yet — I opened the page and the functional web check failed:",
		"",
	];
	if (result.url) lines.push(`URL: ${result.url}`, "");
	if (result.findings.length === 0) {
		lines.push("(no detailed findings)");
	} else {
		for (const f of result.findings.slice(0, 20)) {
			lines.push(`- [${f.phase}] ${f.message}`);
		}
	}
	lines.push(
		"",
		"Fix the underlying cause (broken controls, console/network errors, missing structure) and keep going; don't report the work done until this functional check passes. If the page cannot be rendered locally, say so explicitly instead of assuming it works.",
	);
	return lines.join("\n");
}

interface InteractiveCandidate {
	role: string;
	name: string;
	selector: string;
	kind: "click" | "fill";
}

/**
 * Discover safe interaction candidates via in-page evaluation (CSS selectors),
 * filtered against dangerous labels and password fields.
 */
async function discoverCandidates(
	mgr: ChromeDevtoolsManager,
	max: number,
	signal?: AbortSignal,
): Promise<InteractiveCandidate[]> {
	const expr = `(() => {
		const out = [];
		const push = (role, name, selector, kind) => {
			if (!selector) return;
			out.push({ role, name: (name || "").slice(0, 80), selector, kind });
		};
		const buttons = Array.from(document.querySelectorAll('button, [role="button"], a[href], input[type="button"], input[type="submit"]'));
		for (const el of buttons) {
			const tag = el.tagName.toLowerCase();
			const href = el.getAttribute("href") || "";
			if (tag === "a" && /^https?:\\/\\//i.test(href) && !/^(https?:\\/\\/)?(localhost|127\\.0\\.0\\.1)/i.test(href)) continue;
			const name = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title") || "").trim();
			let selector = "";
			if (el.id) selector = "#" + CSS.escape(el.id);
			else if (tag === "a" && href) selector = 'a[href=' + JSON.stringify(href) + ']';
			else if (tag === "button") {
				const t = (el.innerText || "").trim().slice(0, 40);
				selector = t ? 'button' : 'button';
				if (t) {
					const all = Array.from(document.querySelectorAll("button"));
					const idx = all.indexOf(el);
					if (idx >= 0) selector = 'button:nth-of-type(' + (idx + 1) + ')';
				}
			} else {
				const all = Array.from(document.querySelectorAll(tag));
				const idx = all.indexOf(el);
				if (idx >= 0) selector = tag + ':nth-of-type(' + (idx + 1) + ')';
			}
			push(tag === "a" ? "link" : "button", name, selector, "click");
		}
		const fields = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, [role="textbox"], [role="searchbox"]'));
		for (const el of fields) {
			const type = (el.getAttribute("type") || "text").toLowerCase();
			if (type === "password") continue;
			const name = (el.getAttribute("aria-label") || el.getAttribute("name") || el.getAttribute("placeholder") || el.id || "").trim();
			let selector = "";
			if (el.id) selector = "#" + CSS.escape(el.id);
			else if (el.getAttribute("name")) selector = el.tagName.toLowerCase() + '[name=' + JSON.stringify(el.getAttribute("name")) + ']';
			else {
				const all = Array.from(document.querySelectorAll(el.tagName.toLowerCase()));
				const idx = all.indexOf(el);
				if (idx >= 0) selector = el.tagName.toLowerCase() + ':nth-of-type(' + (idx + 1) + ')';
			}
			push(type === "email" ? "email" : "textbox", name, selector, "fill");
		}
		return out.slice(0, 20);
	})()`;
	const r = await mgr.evaluate(expr, signal);
	if (r.error || !Array.isArray(r.value)) return [];
	const raw = r.value as InteractiveCandidate[];
	const filtered: InteractiveCandidate[] = [];
	for (const c of raw) {
		if (!c?.selector || !c.kind) continue;
		if (DANGEROUS_NAME.test(c.name)) continue;
		if (c.kind === "fill" && PASSWORD_HINT.test(c.name)) continue;
		filtered.push(c);
		if (filtered.length >= max * 2) break;
	}
	return filtered;
}

function analyzeA11yStructure(snapshot: string): FunctionalWebFinding[] {
	const findings: FunctionalWebFinding[] = [];
	if (!snapshot || snapshot === "(empty accessibility tree)") {
		findings.push({ phase: "a11y", message: "Accessibility tree is empty — page may have failed to render." });
		return findings;
	}
	const lower = snapshot.toLowerCase();
	const hasHeading = /\bheading\b/.test(lower) || /\bh[1-6]\b/.test(lower);
	const hasLandmark = /\b(main|banner|navigation|contentinfo|complementary|region)\b/.test(lower) || hasHeading;
	const hasInteractive = /\b(button|link|textbox|searchbox|checkbox|combobox)\b/.test(lower);
	if (!hasLandmark && !hasHeading) {
		findings.push({
			phase: "a11y",
			message: "No headings or landmarks found in the accessibility tree — page structure looks incomplete.",
		});
	}
	if (!hasInteractive) {
		findings.push({
			phase: "a11y",
			message: "No interactive controls (button/link/textbox) found — UI may be non-functional.",
		});
	}
	return findings;
}

/**
 * Run the full functional web check. Never throws to the caller — errors become
 * `skipped` (fail-open) or `failed` with findings.
 */
export async function runFunctionalWebCheck(options: FunctionalWebCheckOptions): Promise<FunctionalWebResult> {
	if (isFunctionalWebDisabled()) {
		return { status: "skipped", findings: [], reason: "kill_switch" };
	}
	if (!options.mgr) {
		return { status: "skipped", findings: [], reason: "chrome_unavailable" };
	}

	const shouldRun = options.touchedVisual || detectWebProject(options.cwd) !== null || Boolean(options.lastVisualFile);
	if (!shouldRun) {
		return { status: "skipped", findings: [], reason: "not_web" };
	}

	const timeoutMs = Math.max(5_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const maxInteractions = Math.max(1, options.maxInteractions ?? DEFAULT_MAX_INTERACTIONS);
	const mgr = options.mgr;

	const parentSignal = options.signal;
	const timeoutCtrl = new AbortController();
	const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
	const onParentAbort = () => timeoutCtrl.abort();
	parentSignal?.addEventListener("abort", onParentAbort, { once: true });
	const signal = timeoutCtrl.signal;

	let resolved: ResolvedTarget | null = null;
	const findings: FunctionalWebFinding[] = [];
	let interactionsAttempted = 0;

	try {
		if (signal.aborted) {
			return { status: "skipped", findings: [], reason: "aborted" };
		}
		const resolveUrl = options.resolveUrl ?? resolveFunctionalWebUrl;
		// URL resolution has no built-in abort; race it so Esc/timeout unblocks
		// even when probing ports or starting a preview server hangs.
		resolved = await new Promise<ResolvedTarget | null>((resolve, reject) => {
			const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
			void resolveUrl({
				cwd: options.cwd,
				lastVisualFile: options.lastVisualFile,
				backgroundJobs: options.backgroundJobs,
			}).then(
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
		if (!resolved || !isAllowedFunctionalWebUrl(resolved.url)) {
			await resolved?.server?.close();
			return { status: "skipped", findings: [], reason: "no_url" };
		}

		await mgr.navigate({ url: resolved.url, newTab: true }, signal);
		await settle(mgr, SETTLE_DEFAULT_MS, signal);

		// Screenshot for evidence path (errors ignored — not required to pass).
		try {
			await mgr.screenshot({ fullPage: false }, signal);
		} catch {
			// ignore
		}

		let snapshot = "";
		try {
			snapshot = await mgr.a11ySnapshot(undefined, signal);
		} catch (err) {
			findings.push({
				phase: "a11y",
				message: `a11y snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
		findings.push(...analyzeA11yStructure(snapshot));

		const urlBefore = (await mgr.evaluate("location.href", signal)).value;
		const textBefore = (await mgr.getPageText(signal).catch(() => "")).slice(0, 2000);

		const candidates = await discoverCandidates(mgr, maxInteractions, signal);
		const clicks = candidates.filter((c) => c.kind === "click").slice(0, maxInteractions);
		const fills = candidates.filter((c) => c.kind === "fill").slice(0, 1);

		let interacted = false;
		for (const c of clicks) {
			if (signal.aborted) break;
			interactionsAttempted++;
			try {
				await mgr.click(c.selector, signal);
				interacted = true;
				await delay(250, signal);
			} catch (err) {
				findings.push({
					phase: "click",
					message: `Failed to click ${c.role} "${c.name || c.selector}": ${err instanceof Error ? err.message : String(err)}`,
				});
			}
		}

		for (const c of fills) {
			if (signal.aborted) break;
			interactionsAttempted++;
			try {
				await mgr.fill(c.selector, "pit-functional-check", signal);
				interacted = true;
				await delay(150, signal);
			} catch (err) {
				findings.push({
					phase: "fill",
					message: `Failed to fill ${c.role} "${c.name || c.selector}": ${err instanceof Error ? err.message : String(err)}`,
				});
			}
		}

		if (interacted) {
			const urlAfter = (await mgr.evaluate("location.href", signal)).value;
			const textAfter = (await mgr.getPageText(signal).catch(() => "")).slice(0, 2000);
			const urlChanged = String(urlAfter) !== String(urlBefore);
			const textChanged = textAfter !== textBefore;
			if (!urlChanged && !textChanged) {
				// Soft signal only when we expected a CTA to do something — still useful.
				findings.push({
					phase: "state",
					message:
						"Interactions ran but URL and visible text did not change — controls may be non-functional (or are no-ops by design).",
				});
			}
		} else if (clicks.length === 0 && fills.length === 0 && findings.every((f) => f.phase !== "a11y")) {
			// No candidates and structure looked ok — still require at least one interactive affordance.
			findings.push({
				phase: "interact",
				message: "No safe clickable/fillable controls discovered to smoke-test.",
			});
		}

		const consoleErrors = mgr.readConsole({ level: "error", limit: 20 });
		const network = mgr.readNetwork({ limit: 100 });
		const failures = network.filter((e) => typeof e.status === "number" && e.status >= 400);
		if (consoleErrors.length > 0) {
			findings.push({
				phase: "console",
				message: `${consoleErrors.length} console error(s): ${consoleErrors
					.slice(0, 5)
					.map((l) => l.text)
					.join(" | ")}`,
			});
		}
		if (failures.length > 0) {
			findings.push({
				phase: "network",
				message: `${failures.length} failed request(s): ${failures
					.slice(0, 5)
					.map((e) => `${e.status} ${e.method} ${e.url}`)
					.join(" | ")}`,
			});
		}

		try {
			await mgr.closePage(undefined, signal);
		} catch {
			// ignore cleanup errors
		}

		const hardFindings = findings.filter((f) => f.phase !== "state");
		// "state" soft finding alone does not fail — many CTAs are intentional no-ops.
		const failed = hardFindings.length > 0;
		return {
			status: failed ? "failed" : "passed",
			url: resolved.url,
			findings,
			consoleErrors: consoleErrors.length,
			networkFailures: failures.length,
			interactionsAttempted,
		};
	} catch (err) {
		if (signal.aborted && !parentSignal?.aborted) {
			return {
				status: "skipped",
				findings: [],
				reason: "timeout",
				url: resolved?.url,
			};
		}
		if (parentSignal?.aborted) {
			return { status: "skipped", findings: [], reason: "aborted", url: resolved?.url };
		}
		// Unexpected Chrome/CDP failure — fail closed so agent-session retries/fix prompts run.
		return {
			status: "failed",
			findings: [
				{
					phase: "error",
					message: err instanceof Error ? err.message : String(err),
				},
			],
			reason: "error",
			url: resolved?.url,
		};
	} finally {
		clearTimeout(timer);
		parentSignal?.removeEventListener("abort", onParentAbort);
		await resolved?.server?.close().catch(() => {});
	}
}
