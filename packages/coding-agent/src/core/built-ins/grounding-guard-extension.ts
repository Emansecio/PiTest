/**
 * Built-in grounding-guard extension (thin adapter).
 *
 * Pre-exec counterpart for symbol-name args: when a `debug` function-breakpoint
 * name or an `lsp` workspace-symbol query names a GLOBAL symbol that does not
 * exist in the project, this auto-corrects a single dominant typo or blocks with
 * candidates — BEFORE the call runs. All the decision logic (the cascade, the
 * reference-only / fail-open invariants) lives in the pure `../grounding-guard.ts`;
 * this adapter only wires the real repo-map + LSP deps and translates the verdict
 * into the extension pipeline's `{ block, reason }` / in-place rewrite.
 *
 * Session state added here: a short-lived symbol-set cache (so a burst of
 * groundable calls doesn't re-scan/re-run git per call) and a fire-once set (an
 * insistent model re-issuing the identical blocked call runs it — the guard
 * advises, never wedges). The whole handler is wrapped in try/catch as
 * defense-in-depth (emitToolCall already isolates per-handler throws) so a
 * guard bug never hard-blocks — fail-open is load-bearing. Opt out with
 * PIT_NO_GROUNDING_GUARD.
 */

import { recordDiagnostic, suggestClosest, suggestClosestN } from "@pit/ai";
import type { ExtensionAPI } from "../extensions/index.js";
import {
	GROUNDING_GUARD_DEFAULTS,
	type GroundingGuardDeps,
	groundToolCall,
	isGroundingGuardDisabled,
	repoMapToSymbolSet,
} from "../grounding-guard.ts";
import { getOrCreateClient, sendRequest } from "../lsp/client.ts";
import { getConfig, getLspServers } from "../lsp/manager.ts";
import type { SymbolInformation } from "../lsp/types.ts";
import { filterWorkspaceSymbols } from "../lsp/utils.ts";
import { getLivingRepoMap } from "../repo-map/living-index.ts";
import { stableToolCallKey } from "./grounding-fire-once.ts";

/** Per-server LSP ceiling: a pre-exec guard must not stall a tool call on a slow server. */
const WORKSPACE_SYMBOL_TIMEOUT_MS = 8000;
/**
 * Reuse the flattened symbol set within this window so a burst of groundable
 * calls doesn't re-scan / re-run the git delta per call. The set is at most this
 * stale; the guard is advisory + fail-open, so a just-created symbol the cache
 * misses simply isn't grounded (allow), never wrongly blocked.
 */
const INDEX_CACHE_TTL_MS = 5000;
/**
 * Same short window for the LSP authority: a burst of groundable debug/lsp calls
 * for the same symbol re-ran `workspace/symbol` across every server each time
 * (up to {@link WORKSPACE_SYMBOL_TIMEOUT_MS} per server), the single biggest
 * latency a strong model feels from the guard. Cache per query so the burst pays
 * one round-trip. At most this stale; the guard is advisory + fail-open, so a
 * just-created symbol the cache misses is simply not grounded (allow), never
 * wrongly blocked. `undefined` (every server errored) is cached too, so a dead
 * server isn't re-probed on every call within the window.
 */
const LSP_CACHE_TTL_MS = 5000;
/** Bound the per-query cache so a long session with many distinct symbols can't grow it unbounded. */
const LSP_CACHE_MAX = 128;

export function createGroundingGuardExtension(options: { cwd: string }) {
	return (pi: ExtensionAPI) => {
		const fired = new Set<string>();
		let indexCache: { at: number; set: Awaited<ReturnType<typeof repoMapToSymbolSet>> } | undefined;
		const lspCache = new Map<string, { at: number; names: string[] | undefined }>();

		// Fast-path pool: flattened symbol names from the living repo-map, memoised
		// for a short window to amortise the git delta + disk read across a burst.
		const indexLookup: GroundingGuardDeps["indexLookup"] = async () => {
			const now = Date.now();
			if (indexCache && now - indexCache.at < INDEX_CACHE_TTL_MS) return indexCache.set;
			const { map } = await getLivingRepoMap(options.cwd);
			const set = repoMapToSymbolSet(map);
			indexCache = { at: now, set };
			return set;
		};

		// Authority: LSP workspace/symbol across every server IN PARALLEL under a
		// shared per-server ceiling, so a hung server caps total latency at one
		// timeout (not N*timeout). undefined when there is no LSP at all OR every
		// server errored (cannot prove absence -> FAIL-OPEN); a name pool otherwise
		// ([] = at least one server answered and found nothing -> block-eligible).
		const lspResolve: GroundingGuardDeps["lspResolve"] = async (query, signal) => {
			const now = Date.now();
			const cached = lspCache.get(query);
			if (cached && now - cached.at < LSP_CACHE_TTL_MS) return cached.names;

			const servers = getLspServers(getConfig(options.cwd));
			if (servers.length === 0) return undefined;
			const perServer = await Promise.all(
				servers.map(async ([, serverConfig]) => {
					try {
						// Cap the (possibly cold) LSP initialize at the guard's own ceiling
						// instead of the 30s client default — a first-session/cold server
						// would otherwise stall the guard ~30s. Fail-open: an init timeout is
						// caught below and the server counts as "did not answer" -> allow.
						const client = await getOrCreateClient(serverConfig, options.cwd, WORKSPACE_SYMBOL_TIMEOUT_MS);
						const res = (await sendRequest(
							client,
							"workspace/symbol",
							{ query },
							signal,
							WORKSPACE_SYMBOL_TIMEOUT_MS,
						)) as SymbolInformation[] | null;
						const names = res ? filterWorkspaceSymbols(res, query).map((sym) => sym.name) : [];
						return { answered: true, names };
					} catch {
						return { answered: false, names: [] as string[] };
					}
				}),
			);
			// undefined when every server errored (cannot prove absence -> FAIL-OPEN).
			const names = perServer.some((r) => r.answered) ? perServer.flatMap((r) => r.names) : undefined;

			if (lspCache.size >= LSP_CACHE_MAX) {
				const oldest = lspCache.keys().next().value;
				if (oldest !== undefined) lspCache.delete(oldest);
			}
			lspCache.set(query, { at: now, names });
			return names;
		};

		pi.on("tool_call", async (event, ctx) => {
			try {
				if (isGroundingGuardDisabled()) return undefined;
				if (event.toolName !== "debug" && event.toolName !== "lsp") return undefined;

				const input = event.input as Record<string, unknown>;
				const decision = await groundToolCall(
					{ toolName: event.toolName, args: input },
					{
						indexLookup,
						lspResolve,
						// Run signal so ESC interrupts a slow workspace/symbol mid-guard (the
						// LSP chain already honors it; only the wiring was dropping it). Optional
						// chaining is load-bearing: subagent-guards invokes the handler with
						// ctx=undefined — `ctx.signal` would throw and silently no-op the guard.
						signal: ctx?.signal,
						fuzzy: suggestClosest,
						fuzzyN: suggestClosestN,
						maxDistance: GROUNDING_GUARD_DEFAULTS.maxDistance,
						prefixMinOverlap: GROUNDING_GUARD_DEFAULTS.prefixMinOverlap,
					},
				);

				if (decision.action === "rewrite") {
					// event.input is mutable in place; patch the corrected args and PASS.
					Object.assign(input, decision.args);
					// Auto-correction: the guard fired and transparently fixed a dominant
					// typo, so the call PASSES. That is neither a block nor a fire-once
					// override, and the outcome enum ("blocked"|"overridden") cannot express
					// an auto-correct — leave outcome absent; ruleId still tags the check.
					recordDiagnostic({
						category: "guard.grounding",
						level: "info",
						source: "grounding-guard-extension",
						context: { note: event.toolName, ruleId: "symbol-not-found" },
					});
					return undefined;
				}
				if (decision.action === "block") {
					const key = stableToolCallKey(event.toolName, input);
					if (fired.has(key)) {
						// The model is OVERRIDING the fire-once advisory by re-issuing the
						// identical call — record the acceptance so override-rate is measurable
						// against the blocks below.
						recordDiagnostic({
							category: "guard.grounding",
							level: "info",
							source: "grounding-guard-extension",
							context: {
								note: event.toolName,
								outcome: "overridden",
								ruleId: "symbol-not-found",
								toolName: event.toolName,
								toolCallId: event.toolCallId,
							},
						});
						return undefined; // already advised once -> let it run
					}
					fired.add(key);
					recordDiagnostic({
						category: "guard.grounding",
						level: "info",
						source: "grounding-guard-extension",
						context: {
							note: event.toolName,
							outcome: "blocked",
							ruleId: "symbol-not-found",
							toolName: event.toolName,
							toolCallId: event.toolCallId,
						},
					});
					return { block: true, reason: decision.message };
				}
				return undefined;
			} catch {
				// Per-handler try/catch in emitToolCall already swallows throws; this
				// inner catch is defense-in-depth so a guard bug never hard-blocks.
				return undefined;
			}
		});
	};
}
