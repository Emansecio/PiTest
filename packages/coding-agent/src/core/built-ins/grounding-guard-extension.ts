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
 * The only session state added here is a fire-once set: if the model re-issues the
 * identical blocked call, it runs — the guard advises, it never wedges (mirrors the
 * learned-error guard's anti-wedge escape). Opt out with PIT_NO_GROUNDING_GUARD.
 */

import { suggestClosest } from "@pit/ai";
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

/** Short LSP timeout: a pre-exec guard must not stall a tool call on a slow server. */
const WORKSPACE_SYMBOL_TIMEOUT_MS = 8000;

export function createGroundingGuardExtension(options: { cwd: string }) {
	return (pi: ExtensionAPI) => {
		// Fire-once per identical blocked call (session-state, not pure logic).
		const fired = new Set<string>();

		// Fast-path pool: flattened symbol names from the living repo-map.
		const indexLookup: GroundingGuardDeps["indexLookup"] = async () => {
			const { map } = await getLivingRepoMap(options.cwd);
			return repoMapToSymbolSet(map);
		};

		// Authority: LSP workspace/symbol. Returns undefined when there is no LSP at
		// all (FAIL-OPEN), an aggregated name pool otherwise ([] = answered-empty).
		const lspResolve: GroundingGuardDeps["lspResolve"] = async (query, signal) => {
			const servers = getLspServers(getConfig(options.cwd));
			if (servers.length === 0) return undefined;
			const names: string[] = [];
			for (const [, serverConfig] of servers) {
				try {
					const client = await getOrCreateClient(serverConfig, options.cwd);
					const res = (await sendRequest(
						client,
						"workspace/symbol",
						{ query },
						signal,
						WORKSPACE_SYMBOL_TIMEOUT_MS,
					)) as SymbolInformation[] | null;
					if (res) for (const sym of filterWorkspaceSymbols(res, query)) names.push(sym.name);
				} catch {
					// Per-server failure: keep aggregating; never throw out of the resolver.
				}
			}
			return names;
		};

		pi.on("tool_call", async (event) => {
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
				return undefined;
			}
			if (decision.action === "block") {
				const key = `${event.toolName}:${JSON.stringify(input)}`;
				if (fired.has(key)) return undefined; // already advised once -> let it run
				fired.add(key);
				return { block: true, reason: decision.message };
			}
			return undefined;
		});
	};
}
