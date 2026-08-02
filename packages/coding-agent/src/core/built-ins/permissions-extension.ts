/**
 * Built-in permissions extension.
 *
 * Subscribes to `tool_call` and gates execution through `PermissionChecker`.
 * plan = read-only (plan ritual), ask = read-only (Q&A stance, same gate),
 * confirm = guarded + human approval per mutation, auto = guarded (built-in deny
 * floor). A `confirm` decision from the checker is resolved here, asynchronously,
 * through `permissions/confirm-gate.ts`.
 *
 * Settings layout (Settings.permissions):
 *   {
 *     "mode": "plan" | "ask" | "confirm" | "auto",
 *     "allowPaths": [{ "glob": "src/**", ... }],
 *     "denyPaths":  [{ "glob": "**\/.env*" }],
 *     "denyCommands": [{ "pattern": "rm\\s+-rf\\s+/" }],
 *     "allowTools": ["read"],
 *     "denyTools":  [],
 *     "disableBuiltinDefaults": false,
 *     "allowlistOnly": false,
 *     "allowCommands": [{ "pattern": "^npm test" }]
 *   }
 *
 * CLI flag `--permission-mode` overrides `mode` for the session; `--allowlist-only`
 * forces `allowlistOnly` on (fail-closed CI preset — orthogonal to the mode, and
 * never part of the mode cycle).
 */

import type { ExtensionAPI } from "../extensions/types.ts";
import type { Orchestration } from "../fusion/types.ts";
import { buildAskModeSection } from "../permissions/ask-mode-prompt.ts";
import { buildConfirmModeSection } from "../permissions/confirm-mode-prompt.ts";
import { createExitPlanToolDefinition } from "../permissions/exit-plan-tool.ts";
import {
	describeToolAction,
	formatPermissionBlockedContent,
	humanModeNotifyLabel,
	normalizePermissionMode,
	type PermissionChecker,
	type PermissionMode,
	type PermissionSettings,
	resolveConfirmDecision,
} from "../permissions/index.ts";
import { buildPlanModeSection } from "../permissions/plan-mode-prompt.ts";
import { PERMISSION_MODES } from "../permissions/types.ts";

/** Transcript custom-type for compact permission-deny lines (see custom-message.ts). */
export const PERMISSION_BLOCKED_CUSTOM_TYPE = "pit.permission-blocked";

const STATUS_KEY = "permissions";

/**
 * UI label for the current permission state. When the built-in floor is off
 * (a mode with `disableBuiltinDefaults`) we surface "no-rails" so the footer can
 * shout the dropped-floor state regardless of the literal mode — that alarm wins
 * over every other facet, including fail-closed (the footer keys its red banner
 * off the exact string "no-rails").
 *
 * The fail-closed CI preset (`allowlistOnly`) rides as a suffix on the mode
 * (`auto·fail-closed`) — no space, so the footer's `permissions:\s*(\S+)` capture
 * keeps it whole, and the composite is `!== "auto"` so the metrics line shows it
 * instead of hiding it as the boring default.
 */
function permissionDisplayLabel(checker: PermissionChecker): string {
	if (!checker.builtinsActive) return "no-rails";
	return checker.failClosed ? `${checker.mode}·fail-closed` : checker.mode;
}

/**
 * Composite footer label that folds the Fusion orchestration facet over the base
 * permission label: `fusion · <base>` when fusion is active, else just `<base>`.
 */
export function modeDisplayLabel(checker: PermissionChecker, orchestration: Orchestration): string {
	const base = permissionDisplayLabel(checker);
	return orchestration === "fusion" ? `fusion · ${base}` : base;
}

/**
 * Pure 4-stop cycle over (orchestration × permission mode):
 *   Plan → Ask → Auto → Fusion·Plan → Plan.
 * The two read-only stops come first (plan builds a DAG, ask answers questions),
 * then the permissive one, then the multi-model panel. Fusion always rides on
 * plan-mode (read-only) in v1 — there is no Fusion·Ask or Fusion·Auto.
 *
 * `confirm` is deliberately NOT a stop: it is a deliberate, sticky choice (every
 * mutation costs a keystroke), not something to land on by cycling past. It is
 * reachable only via `/permission-mode confirm` and `--permission-mode confirm`.
 */
export function nextFusionCycleState(
	orchestration: Orchestration,
	mode: PermissionMode,
): { orchestration: Orchestration; mode: PermissionMode } {
	if (orchestration === "fusion") return { orchestration: "solo", mode: "plan" }; // Fusion·Plan → Plan
	if (mode === "plan") return { orchestration: "solo", mode: "ask" }; // Plan → Ask
	if (mode === "ask") return { orchestration: "solo", mode: "auto" }; // Ask → Auto
	// Off-cycle mode (confirm): re-enter the loop at its first stop rather than at
	// the next one. A stray cycle key from a mode the loop does not contain must
	// never make the session MORE permissive than it already was.
	if (mode === "confirm") return { orchestration: "solo", mode: "plan" }; // Confirm → Plan
	return { orchestration: "fusion", mode: "plan" }; // Auto → Fusion·Plan
}

/**
 * v1 Mode invariant — the single source of truth for the two-facet coupling.
 * Orchestration `fusion` implies permission `plan`: neither Fusion·Auto nor
 * Fusion·Ask exists in v1 (the cycle in {@link nextFusionCycleState} never
 * produces them), so ANY pairing of `fusion` with a mode other than `plan` is
 * illegal. Given the desired facet values and which facet the caller is
 * authoritatively setting, this returns the legal pair — the authoritative facet
 * is kept, the other bends. Every coupling site routes through here (exit_plan
 * approval, `/permission-mode`, session restore) so the rule lives in one place
 * instead of three ad-hoc resets that can drift apart.
 */
export function reconcileFusionModeInvariant(
	desired: { mode: PermissionMode; orchestration: Orchestration },
	authority: "permission" | "orchestration",
): { mode: PermissionMode; orchestration: Orchestration } {
	if (desired.orchestration === "fusion" && desired.mode !== "plan") {
		// Illegal fusion pairing: keep the facet the caller deliberately set, bend the other.
		return authority === "permission"
			? { mode: desired.mode, orchestration: "solo" } // deliberately leaving plan leaves fusion
			: { mode: "plan", orchestration: "fusion" }; // restored fusion forces plan
	}
	return desired;
}

export interface PermissionsExtensionOptions {
	cwd: string;
	checker: PermissionChecker;
	/** Optional callback fired whenever a decision is made (for audit/logging). */
	onDecision?: (info: { toolName: string; decision: "allow" | "deny"; reason?: string }) => void;
	/** Fired after the permission mode changes (via /permission-mode, the cycle key, or exit_plan approval). Lets the host swap model roles etc. */
	onModeChange?: (mode: PermissionMode) => void;
	/** True when Fusion panel has ≥2 advisors configured. Gates Alt+P into Fusion. */
	isFusionPanelReady?: () => boolean;
	/** Open `/fusion` setup when the user cycles into Fusion without a panel. */
	onFusionNeedsSetup?: () => void;
}

export function createPermissionsExtension(options: PermissionsExtensionOptions) {
	return (pi: ExtensionAPI) => {
		const { checker, onDecision, onModeChange, isFusionPanelReady, onFusionNeedsSetup } = options;
		// Capture the last UI context seen so the exit_plan `onApproved` callback
		// (which runs inside a tool execute() with no extension ctx) can still
		// refresh the footer status. `let` in the closure, updated on session_start.
		let lastUiCtx: { hasUI: boolean; ui: { setStatus: (key: string, value: string) => void } } | undefined;

		const refreshStatus = (orchestration: Orchestration) => {
			if (lastUiCtx?.hasUI) {
				lastUiCtx.ui.setStatus(STATUS_KEY, `permissions: ${modeDisplayLabel(checker, orchestration)}`);
			}
		};

		pi.on("session_start", (_event, ctx) => {
			lastUiCtx = { hasUI: ctx.hasUI, ui: ctx.ui };
			if (ctx.hasUI) {
				ctx.ui.setStatus(STATUS_KEY, `permissions: ${modeDisplayLabel(checker, pi.getOrchestration())}`);
			}
		});

		// Tell the model UP FRONT which stance it is in, so it researches (plan),
		// answers (ask), or batches its mutations (confirm) instead of fighting the
		// permission layer. Same checker, different posture — hence one section per
		// non-default mode. Pre-model band: appended after the system prompt's
		// dynamic marker, so the cacheable prefix is preserved.
		pi.on("before_agent_start", (event) => {
			const section =
				checker.mode === "plan"
					? buildPlanModeSection()
					: checker.mode === "ask"
						? buildAskModeSection()
						: checker.mode === "confirm"
							? buildConfirmModeSection()
							: undefined;
			if (!section) return undefined;
			return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
		});

		// Async on purpose: a `confirm` decision parks here awaiting the user's
		// answer. The host awaits this handler through `settleOrAbort`, so Esc/abort
		// still unblocks the turn (the interrupt path also cancels the input bus) —
		// the checker itself stays pure and synchronous.
		pi.on("tool_call", async (event, _ctx) => {
			const action = describeToolAction(event.toolName, event.input);
			const decision = checker.check(action);
			// Resolve the confirm deferral to a real verdict BEFORE anything is
			// audited or blocked, so the audit callback and the transcript notice only
			// ever see allow/deny. Never fall through: an unhandled "confirm" here
			// would silently un-gate every mutation the mode exists to gate.
			const resolved =
				decision.decision === "confirm" ? await resolveConfirmDecision(checker, action, decision.reason) : decision;
			const reason = "reason" in resolved ? resolved.reason : undefined;
			onDecision?.({
				toolName: event.toolName,
				decision: resolved.decision,
				reason,
			});

			if (resolved.decision === "deny") {
				// Quiet one-line transcript notice so vibecoders see *why* (mode/rule),
				// not only a failed tool row. Model still gets the block reason.
				const content = formatPermissionBlockedContent(event.toolName, reason, checker.mode);
				pi.sendMessage({
					customType: PERMISSION_BLOCKED_CUSTOM_TYPE,
					content,
					display: true,
				});
				return { block: true, reason };
			}
			return undefined;
		});

		// Re-evaluate when the user changes mode mid-session via /permission-mode
		pi.registerCommand("permission-mode", {
			description: `Switch permission mode (${PERMISSION_MODES.join(" | ")})`,
			async handler(args, ctx) {
				const trimmed = args.trim();
				if (trimmed.length === 0) {
					ctx.ui.notify(`Current mode: ${checker.mode}`, "info");
					return;
				}
				const mode = normalizePermissionMode(trimmed);
				if (!mode) {
					ctx.ui.notify(`Invalid mode "${trimmed}". Use ${PERMISSION_MODES.join(" | ")}.`, "warning");
					return;
				}
				checker.updateMode(mode);
				// v1 invariant: leaving plan (for ask or auto) from Fusion·Plan must drop
				// fusion — Fusion·Ask/Fusion·Auto are unreachable via the cycle and must
				// stay unreachable here. Reconcile the facets through the coupling helper.
				const reconciled = reconcileFusionModeInvariant(
					{ mode: checker.mode, orchestration: pi.getOrchestration() },
					"permission",
				);
				if (reconciled.orchestration !== pi.getOrchestration()) {
					pi.setOrchestration(reconciled.orchestration);
				}
				const orch = pi.getOrchestration();
				ctx.ui.setStatus(STATUS_KEY, `permissions: ${modeDisplayLabel(checker, orch)}`);
				ctx.ui.notify(humanModeNotifyLabel(orch, mode), "info");
				onModeChange?.(mode);
			},
		});

		// 4-stop cycle over orchestration × mode: plan → ask → auto → fusion·plan (bound to a keybinding).
		pi.registerCommand("permission-cycle", {
			description: "Cycle mode: plan → ask → auto → fusion·plan",
			async handler(_args, ctx) {
				const current = pi.getOrchestration();
				const next = nextFusionCycleState(current, checker.mode);
				// Don't enter Fusion with an empty panel — nudge into /fusion setup instead.
				if (next.orchestration === "fusion" && isFusionPanelReady && !isFusionPanelReady()) {
					ctx.ui.notify("Fusion needs two advisors — opening /fusion", "warning");
					onFusionNeedsSetup?.();
					return;
				}
				checker.updateMode(next.mode);
				pi.setOrchestration(next.orchestration);
				ctx.ui.setStatus(STATUS_KEY, `permissions: ${modeDisplayLabel(checker, next.orchestration)}`);
				ctx.ui.notify(humanModeNotifyLabel(next.orchestration, next.mode), "info");
				onModeChange?.(next.mode);
			},
		});

		// exit_plan: the model calls this to present its structured plan for user
		// approval. On approval the checker flips to "auto" atomically (the model
		// cannot change its own permission mode), the plan is written to a durable
		// artifact, and onModeChange fires so the host can switch model roles. The
		// tool stays registered in every mode; the plan-mode guard is internal so
		// the tool surface stays stable across mode flips.
		pi.registerTool(
			createExitPlanToolDefinition({
				cwd: options.cwd,
				checker,
				onApproved: () => {
					// v1 invariant (fusion-mode spec, "v1 cycle"): fusion rides on
					// plan-mode only. Approval leaves plan for auto, so it must also
					// leave fusion — otherwise the next turn re-routes through the
					// read-only panel instead of executing the approved plan (fusion·auto
					// is unreachable via the cycle and must stay unreachable here). The
					// checker is already "auto" at this point, so only orchestration may
					// bend; reconcile through the single coupling helper.
					const reconciled = reconcileFusionModeInvariant(
						{ mode: checker.mode, orchestration: pi.getOrchestration() },
						"permission",
					);
					if (reconciled.orchestration !== pi.getOrchestration()) {
						pi.setOrchestration(reconciled.orchestration);
					}
					refreshStatus(pi.getOrchestration());
					onModeChange?.("auto");
				},
			}),
		);
	};
}

/** Default permission settings: guarded auto mode. */
export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
	mode: "auto",
};
