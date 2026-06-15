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
 * advises, never wedges). The whole handler is wrapped in try/catch because
 * `emitToolCall` has no per-handler isolation and a throw out of beforeToolCall
 * would hard-block the call — fail-open is load-bearing. Opt out with
 * PIT_NO_GROUNDING_GUARD.
 */

import { recordDiagnostic, suggestClosest } from "@pit/ai";
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

/** Per-server LSP ceiling: a pre-exec guard must not stall a tool call on a slow server. */
const WORKSPACE_SYMBOL_TIMEOUT_MS = 8000;
/**
 * Reuse the flattened symbol set within this window so a burst of groundable
 * calls doesn't re-scan / re-run the git delta per call. The set is at most this
 * stale; the guard is advisory + fail-open, so a just-created symbol the cache
 * misses simply isn't grounded (allow), never wrongly blocked.
 */
const INDEX_CACHE_TTL_MS = 5000;

export function createGroundingGuardExtension(options: { cwd: string }) {
	return (pi: ExtensionAPI) => {
		const fired = new Set<string>();
		let indexCache: { at: number; names: Set<string> } | undefined;

		// Fast-path pool: flattened symbol names from the living repo-map, memoised
		// for a short window to amortise the git delta + disk read across a burst.
		const indexLookup: GroundingGuardDeps["indexLookup"] = async () => {
			const now = Date.now();
			if (indexCache && now - indexCache.at < INDEX_CACHE_TTL_MS) return indexCache.names;
			const { map } = await getLivingRepoMap(options.cwd);
			const names = repoMapToSymbolSet(map);
			indexCache = { at: now, names };
			return names;
		};

		// Authority: LSP workspace/symbol across every server IN PARALLEL under a
		// shared per-server ceiling, so a hung server caps total latency at one
		// timeout (not N*timeout). undefined when there is no LSP at all OR every
		// server errored (cannot prove absence -> FAIL-OPEN); a name pool otherwise
		// ([] = at least one server answered and found nothing -> block-eligible).
		const lspResolve: GroundingGuardDeps["lspResolve"] = async (query, signal) => {
			const servers = getLspServers(getConfig(options.cwd));
			if (servers.length === 0) return undefined;
			const perServer = await Promise.all(
				servers.map(async ([, serverConfig]) => {
					try {
						const client = await getOrCreateClient(serverConfig, options.cwd);
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
			if (!perServer.some((r) => r.answered)) return undefined; // every server errored -> FAIL-OPEN
			return perServer.flatMap((r) => r.names);
		};

		pi.on("tool_call", async (event) => {
			try {
				if (isGroundingGuardDisabled()) return undefined;
				if (event.toolName !== "debug" && event.toolName !== "lsp") return undefined;

				const input = event.input as Record<string, unknown>;
				const decision = await groundToolCall(
					{ toolName: event.toolName, args: input },
					{
						indexLookup,
						lspResolve,
						fuzzy: suggestClosest,
						maxDistance: GROUNDING_GUARD_DEFAULTS.maxDistance,
						prefixMinOverlap: GROUNDING_GUARD_DEFAULTS.prefixMinOverlap,
					},
				);

				if (decision.action === "rewrite") {
					// event.input is mutable in place; patch the corrected args and PASS.
					Object.assign(input, decision.args);
					recordDiagnostic({
						category: "guard.grounding",
						level: "info",
						source: "grounding-guard-extension",
						context: { note: event.toolName },
					});
					return undefined;
				}
				if (decision.action === "block") {
					// Stable key (sorted top-level arg keys) so a verbatim re-issue with
					// reordered keys still matches the fire-once escape.
					const key = `${event.toolName}:${JSON.stringify(input, Object.keys(input).sort())}`;
					if (fired.has(key)) return undefined; // already advised once -> let it run
					fired.add(key);
					recordDiagnostic({
						category: "guard.grounding",
						level: "info",
						source: "grounding-guard-extension",
						context: { note: event.toolName },
					});
					return { block: true, reason: decision.message };
				}
				return undefined;
			} catch {
				// emitToolCall has no per-handler try/catch; a throw out of beforeToolCall
				// would hard-block the call. Fail-open is the invariant -> swallow.
				return undefined;
			}
		});
	};
}
