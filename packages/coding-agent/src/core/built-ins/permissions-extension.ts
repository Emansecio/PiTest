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
import {
	describeToolAction,
	normalizePermissionMode,
	type PermissionChecker,
	type PermissionSettings,
} from "../permissions/index.ts";

const STATUS_KEY = "permissions";

/**
 * UI label for the current permission state. When the built-in floor is off
 * (a mode with `disableBuiltinDefaults`) we surface "no-rails" so the footer can
 * shout the dropped-floor state regardless of the literal mode.
 */
function permissionDisplayLabel(checker: PermissionChecker): string {
	return checker.builtinsActive ? checker.mode : "no-rails";
}

export interface PermissionsExtensionOptions {
	checker: PermissionChecker;
	/** Optional callback fired whenever a decision is made (for audit/logging). */
	onDecision?: (info: { toolName: string; decision: "allow" | "deny"; reason?: string }) => void;
}

export function createPermissionsExtension(options: PermissionsExtensionOptions) {
	return (pi: ExtensionAPI) => {
		const { checker, onDecision } = options;

		pi.on("session_start", (_event, ctx) => {
			if (!ctx.hasUI) return;
			ctx.ui.setStatus(STATUS_KEY, `permissions: ${permissionDisplayLabel(checker)}`);
		});

		pi.on("tool_call", (event, _ctx) => {
			const action = describeToolAction(event.toolName, event.input);
			const decision = checker.check(action);
			onDecision?.({
				toolName: event.toolName,
				decision: decision.decision,
				reason: "reason" in decision ? decision.reason : undefined,
			});

			if (decision.decision === "deny") {
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
				ctx.ui.setStatus(STATUS_KEY, `permissions: ${permissionDisplayLabel(checker)}`);
				ctx.ui.notify(`Permission mode → ${mode}`, "info");
			},
		});

		// Cycle between plan and auto (bound to a keybinding).
		pi.registerCommand("permission-cycle", {
			description: "Cycle permission mode between plan and auto",
			async handler(_args, ctx) {
				const next = checker.mode === "auto" ? "plan" : "auto";
				checker.updateMode(next);
				ctx.ui.setStatus(STATUS_KEY, `permissions: ${permissionDisplayLabel(checker)}`);
				ctx.ui.notify(`Permission mode → ${next}`, "info");
			},
		});
	};
}

/** Default permission settings: guarded auto mode. */
export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
	mode: "auto",
};
