/**
 * Built-in permissions extension.
 *
 * Subscribes to `tool_call` and gates execution through `PermissionChecker`.
 * plan = read-only, auto = guarded (built-in deny floor).
 *
 * Settings layout (Settings.permissions):
 *   {
 *     "mode": "plan" | "auto",
 *     "allowPaths": [{ "glob": "src/**", ... }],
 *     "denyPaths":  [{ "glob": "**\/.env*" }],
 *     "denyCommands": [{ "pattern": "rm\\s+-rf\\s+/" }],
 *     "allowTools": ["read"],
 *     "denyTools":  [],
 *     "disableBuiltinDefaults": false
 *   }
 *
 * CLI flag `--permission-mode` overrides `mode` for the session.
 */

import type { ExtensionAPI } from "../extensions/types.ts";
import type { Orchestration } from "../fusion/types.ts";
import { createExitPlanToolDefinition } from "../permissions/exit-plan-tool.ts";
import {
	describeToolAction,
	formatPermissionBlockedContent,
	humanModeNotifyLabel,
	normalizePermissionMode,
	type PermissionChecker,
	type PermissionMode,
	type PermissionSettings,
} from "../permissions/index.ts";
import { buildPlanModeSection } from "../permissions/plan-mode-prompt.ts";

/** Transcript custom-type for compact permission-deny lines (see custom-message.ts). */
export const PERMISSION_BLOCKED_CUSTOM_TYPE = "pit.permission-blocked";

const STATUS_KEY = "permissions";

/**
 * UI label for the current permission state. When the built-in floor is off
 * (a mode with `disableBuiltinDefaults`) we surface "no-rails" so the footer can
 * shout the dropped-floor state regardless of the literal mode.
 */
function permissionDisplayLabel(checker: PermissionChecker): string {
	return checker.builtinsActive ? checker.mode : "no-rails";
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
 * Pure 3-stop cycle over (orchestration × permission mode):
 *   Plan → Auto → Fusion·Plan → Plan.
 * Fusion always rides on plan-mode (read-only) in v1.
 */
export function nextFusionCycleState(
	orchestration: Orchestration,
	mode: PermissionMode,
): { orchestration: Orchestration; mode: PermissionMode } {
	if (orchestration === "fusion") return { orchestration: "solo", mode: "plan" }; // Fusion·Plan → Plan
	if (mode === "plan") return { orchestration: "solo", mode: "auto" }; // Plan → Auto
	return { orchestration: "fusion", mode: "plan" }; // Auto → Fusion·Plan
}

export interface PermissionsExtensionOptions {
	cwd: string;
	checker: PermissionChecker;
	/** Optional callback fired whenever a decision is made (for audit/logging). */
	onDecision?: (info: { toolName: string; decision: "allow" | "deny"; reason?: string }) => void;
	/** Fired after the permission mode changes (via /permission-mode, the cycle key, or exit_plan approval). Lets the host swap model roles etc. */
	onModeChange?: (mode: PermissionMode) => void;
}

export function createPermissionsExtension(options: PermissionsExtensionOptions) {
	return (pi: ExtensionAPI) => {
		const { checker, onDecision, onModeChange } = options;
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

		// Tell the model UP FRONT it is in plan mode so it researches + plans
		// instead of fighting the permission layer. Pre-model band: appended after
		// the system prompt's dynamic marker, so the cacheable prefix is preserved.
		pi.on("before_agent_start", (event) => {
			if (checker.mode !== "plan") return undefined;
			return { systemPrompt: `${event.systemPrompt}\n\n${buildPlanModeSection()}` };
		});

		pi.on("tool_call", (event, _ctx) => {
			const action = describeToolAction(event.toolName, event.input);
			const decision = checker.check(action);
			const reason = "reason" in decision ? decision.reason : undefined;
			onDecision?.({
				toolName: event.toolName,
				decision: decision.decision,
				reason,
			});

			if (decision.decision === "deny") {
				// Quiet one-line transcript notice so vibecoders see *why* (mode/rule),
				// not only a failed tool row. Model still gets the block reason.
				const content = formatPermissionBlockedContent(event.toolName, reason, checker.mode);
				pi.sendMessage({
					customType: PERMISSION_BLOCKED_CUSTOM_TYPE,
					content,
					display: true,
				});
				return { block: true, reason: decision.reason };
			}
			return undefined;
		});

		// Re-evaluate when the user changes mode mid-session via /permission-mode
		pi.registerCommand("permission-mode", {
			description: "Switch permission mode (plan | auto)",
			async handler(args, ctx) {
				const trimmed = args.trim();
				if (trimmed.length === 0) {
					ctx.ui.notify(`Current mode: ${checker.mode}`, "info");
					return;
				}
				const mode = normalizePermissionMode(trimmed);
				if (!mode) {
					ctx.ui.notify(`Invalid mode "${trimmed}". Use plan | auto.`, "warning");
					return;
				}
				checker.updateMode(mode);
				const orch = pi.getOrchestration();
				ctx.ui.setStatus(STATUS_KEY, `permissions: ${modeDisplayLabel(checker, orch)}`);
				ctx.ui.notify(humanModeNotifyLabel(orch, mode), "info");
				onModeChange?.(mode);
			},
		});

		// 3-stop cycle over orchestration × mode: plan → auto → fusion·plan (bound to a keybinding).
		pi.registerCommand("permission-cycle", {
			description: "Cycle mode: plan → auto → fusion·plan",
			async handler(_args, ctx) {
				const current = pi.getOrchestration();
				const next = nextFusionCycleState(current, checker.mode);
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
