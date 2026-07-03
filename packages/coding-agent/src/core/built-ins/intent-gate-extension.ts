/**
 * Built-in intent-gate extension (Band P / pillar P2 — the enforcement half).
 *
 * Thin adapter over the pure `../intent-gate.ts` validator. Per prompt cycle:
 *   - `before_agent_start`: classify task rigor from the prompt and RESET the
 *     per-cycle state. This is the ONLY reset point — NOT `turn_start`. A blocked
 *     edit ends the turn, so the ≤2-block anti-lock budget must survive across the
 *     turns of one prompt cycle; resetting per turn would re-arm the block every
 *     turn and wedge the model forever. `before_agent_start` is the true
 *     per-prompt-cycle boundary (it also drives the thermostat's task boundary).
 *   - `tool_call` for a mutating tool (write/edit/edit_v2/ast_edit): if the cycle
 *     is risky per the dosing matrix (thermostat level × rigor) and the gate is not
 *     yet open, require a plan and validate it. No plan -> block once (asking for
 *     `plan propose`); plan with findings -> block once (with candidates); a
 *     grounded plan (no findings) OPENS the gate for the rest of the cycle.
 *
 * Dosing (§5): block at assistido (rigor ≥ 2); nudge rigor 2 / block rigor 3 at
 * padrao; nudge rigor 3 at leve. Undefined thermostat registry -> padrao.
 *
 * Anti-lock: at most 2 blocks per cycle, then DEGRADE to a one-shot steer nudge —
 * the gate advises, it never wedges. Nudge dose = allow the call + a single steer.
 *
 * Diagnostics: emitted under the dedicated `guard.intent-gate` category (already
 * present in the @pit/ai taxonomy — no packages/ai change) with ruleId
 * `intent-gate-no-plan` / `intent-gate-plan-findings` and outcome blocked/overridden,
 * so per-rule efficacy is measurable alongside the other guards. (Note: the spec
 * suggested `quality.rigor` as a provisional home, but that category is the
 * thermostat's task-BOUNDARY/loosen signal — emitting gate blocks there would
 * falsely loosen supervision; `guard.intent-gate` is the correct, already-defined
 * home and also feeds the thermostat's tighten path like every other guard block.)
 *
 * FAIL-OPEN everywhere: the kill-switch `PIT_NO_INTENT_GATE=1` and any internal
 * throw leave the call to run. Parent-only (it reads the session-global plan /
 * thermostat registries) — registered via the parent's insertAfterEditPrecondition
 * slot, never propagated to subagents.
 */

import { existsSync, readdirSync } from "node:fs";
import { recordDiagnostic, suggestClosest, suggestClosestN } from "@pit/ai";
import type { ExtensionAPI } from "../extensions/index.js";
import { repoMapToSymbolSet } from "../grounding-guard.ts";
import {
	formatIntentGateFindings,
	type IntentGateDeps,
	type IntentGateDose,
	intentGateDose,
	isIntentGateDisabled,
	validatePlan,
} from "../intent-gate.ts";
import { getCurrentPlanManager } from "../plan/plan-manager.ts";
import { getLivingRepoMap } from "../repo-map/living-index.ts";
import { MUTATING_TOOL_NAMES } from "../stagnation.ts";
import { getCurrentSupervisionThermostat } from "../supervision-thermostat.ts";
import type { RigorLevel } from "../task-rigor.ts";
import { classifyTaskRigor } from "../task-rigor.ts";
import { expandPath, resolveReadPath, sameCanonicalName } from "../tools/path-utils.ts";

/** Anti-lock: never block more than this many mutating calls per prompt cycle. */
const MAX_BLOCKS_PER_CYCLE = 2;

const NO_PLAN_MESSAGE =
	"Intent gate (no edit attempted): this is a risky task and no validated plan exists yet. " +
	'Call the `plan` tool (op "propose") with 3-7 short steps, each naming the file(s) it will touch, ' +
	"BEFORE editing. Then retry — a grounded plan opens the gate for the rest of this task. " +
	"(If you must proceed without a plan, repeat the edit; the gate steps aside after a couple of attempts.)";

export function createIntentGateExtension(options: { cwd: string }): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		// Per-prompt-cycle state (reset at before_agent_start).
		let rigor: RigorLevel = 0;
		let gateOpen = false;
		let blockCount = 0;
		let nudged = false;
		// The repo-map symbol set is fetched at most once per cycle, lazily, the first
		// time a plan is validated (cheap: living-index is incremental/cached).
		let symbolSet: Set<string> | undefined;
		let symbolFetched = false;

		function resetCycle(): void {
			rigor = 0;
			gateOpen = false;
			blockCount = 0;
			nudged = false;
			symbolSet = undefined;
			symbolFetched = false;
		}

		function emit(ruleId: string, outcome: "blocked" | "overridden", note: string): void {
			recordDiagnostic({
				category: "guard.intent-gate",
				level: "info",
				source: "intent-gate-extension",
				context: { note, outcome, ruleId },
			});
		}

		async function buildDeps(): Promise<IntentGateDeps> {
			if (!symbolFetched) {
				symbolFetched = true;
				try {
					const { map } = await getLivingRepoMap(options.cwd);
					symbolSet = repoMapToSymbolSet(map);
				} catch {
					symbolSet = undefined; // FAIL-OPEN: symbols simply skip the fast-path.
				}
			}
			return {
				resolve: (raw) => resolveReadPath(raw, options.cwd),
				fileExists: (absPath) => existsSync(absPath),
				listDir: (absDir) => readdirSync(absDir),
				fuzzy: suggestClosest,
				fuzzyN: suggestClosestN,
				normalize: expandPath,
				sameName: sameCanonicalName,
				symbolSet,
				// symbolResolve intentionally omitted in v1 (repo-map-only, fail-open).
			};
		}

		/**
		 * Apply the dose. At block-dose within budget: block once (record blocked).
		 * At nudge-dose OR once the block budget is spent (anti-lock degrade): allow
		 * the call and fire a single steer nudge (record overridden).
		 */
		function decide(
			dose: IntentGateDose,
			ruleId: string,
			message: string,
			toolName: string,
		): { block: true; reason: string } | undefined {
			if (dose === "block" && blockCount < MAX_BLOCKS_PER_CYCLE) {
				blockCount++;
				emit(ruleId, "blocked", toolName);
				return { block: true, reason: message };
			}
			if (!nudged) {
				nudged = true;
				emit(ruleId, "overridden", toolName);
				try {
					pi.sendMessage(
						{ customType: "pi.intent-gate", content: message, display: false },
						{ deliverAs: "steer" },
					);
				} catch {
					/* steer is best-effort; never let it wedge the call */
				}
			}
			return undefined;
		}

		pi.on("before_agent_start", (event) => {
			resetCycle();
			try {
				if (isIntentGateDisabled()) return undefined;
				rigor = classifyTaskRigor(event.prompt).rigor;
			} catch {
				rigor = 0; // FAIL-OPEN
			}
			return undefined;
		});

		pi.on("tool_call", async (event) => {
			try {
				if (isIntentGateDisabled()) return undefined;
				if (!MUTATING_TOOL_NAMES.has(event.toolName)) return undefined;
				if (gateOpen) return undefined;

				// Undefined thermostat registry -> padrao (the documented default).
				const level = getCurrentSupervisionThermostat()?.getLevel() ?? "padrao";
				const dose = intentGateDose(level, rigor);
				if (dose === "off") return undefined;

				const plan = getCurrentPlanManager();
				const version = plan && !plan.isEmpty() ? plan.current() : undefined;

				if (version) {
					const findings = validatePlan(version, await buildDeps());
					if (findings.length === 0) {
						gateOpen = true; // grounded plan -> gate stays open for the rest of the cycle.
						return undefined;
					}
					return decide(dose, "intent-gate-plan-findings", formatIntentGateFindings(findings), event.toolName);
				}

				return decide(dose, "intent-gate-no-plan", NO_PLAN_MESSAGE, event.toolName);
			} catch {
				return undefined; // FAIL-OPEN
			}
		});
	};
}
