/**
 * Built-in permissions extension.
 *
 * Subscribes to `tool_call` and gates execution through `PermissionChecker`.
 * plan = read-only, auto = guarded (built-in deny floor), unsafe = no-rails.
 *
 * Settings layout (Settings.permissions):
 *   {
 *     "mode": "plan" | "auto" | "unsafe",
 *     "allowPaths": [{ "glob": "src/**", ... }],
 *     "denyPaths":  [{ "glob": "**\/.env*" }],
 *     "denyCommands": [{ "pattern": "rm\\s+-rf\\s+/" }],
 *     "allowTools": ["read"],
 *     "denyTools":  [],
 *     "disableBuiltinDefaults": false
 *   }
 *
 * CLI flag `--permission-mode` (or `--unsafe`) overrides `mode` for the session.
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
 * (unsafe mode, or auto + disableBuiltinDefaults) we always surface "unsafe" so
 * the footer can shout the no-rails state regardless of the literal mode.
 */
function permissionDisplayLabel(checker: PermissionChecker): string {
	return checker.builtinsActive ? checker.mode : "unsafe";
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
			description: "Switch permission mode (plan | auto | unsafe)",
			async handler(args, ctx) {
				const trimmed = args.trim();
				if (trimmed.length === 0) {
					ctx.ui.notify(`Current mode: ${checker.mode}`, "info");
					return;
				}
				const mode = normalizePermissionMode(trimmed);
				if (!mode) {
					ctx.ui.notify(`Invalid mode "${trimmed}". Use plan | auto | unsafe.`, "warning");
					return;
				}
				checker.updateMode(mode);
				ctx.ui.setStatus(STATUS_KEY, `permissions: ${permissionDisplayLabel(checker)}`);
				ctx.ui.notify(`Permission mode → ${mode}`, mode === "unsafe" ? "warning" : "info");
			},
		});

		// Shortcut for the no-rails tier — surfaced loudly because it drops the floor.
		pi.registerCommand("unsafe", {
			description: "Drop the built-in safety floor for this session (no-rails; authorized targets only)",
			async handler(_args, ctx) {
				checker.updateMode("unsafe");
				ctx.ui.setStatus(STATUS_KEY, `permissions: ${permissionDisplayLabel(checker)}`);
				ctx.ui.notify("⚠ Permission mode → unsafe (built-in guard-rails off)", "warning");
			},
		});

		// Cycle between plan and auto (bound to a keybinding). `unsafe` stays out of
		// the cycle — entering no-rails must be deliberate (/unsafe). From unsafe,
		// a cycle lands on the guarded `auto`.
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
