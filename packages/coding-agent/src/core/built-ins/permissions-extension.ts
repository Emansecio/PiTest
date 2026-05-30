/**
 * Built-in permissions extension.
 *
 * Subscribes to `tool_call` and gates execution through `PermissionChecker`.
 * Auto/yolo mode allows everything. Plan mode is read-only.
 *
 * Settings layout (Settings.permissions):
 *   {
 *     "mode": "auto" | "yolo" | "plan",
 *     "allowPaths": [{ "glob": "src/**", ... }],
 *     "denyPaths":  [{ "glob": "**\/.env*" }],
 *     "askPaths":   [{ "glob": "**\/build/**" }],
 *     "denyCommands": [{ "pattern": "rm\\s+-rf\\s+/" }],
 *     "askCommands":  [{ "pattern": "git\\s+push" }],
 *     "allowTools": ["read"],
 *     "denyTools":  []
 *   }
 *
 * CLI flag `--permission-mode` overrides `mode` for the current session.
 */

import type { ExtensionAPI } from "../extensions/types.ts";
import {
	describeToolAction,
	normalizePermissionMode,
	type PermissionChecker,
	type PermissionSettings,
} from "../permissions/index.ts";

const STATUS_KEY = "permissions";

export interface PermissionsExtensionOptions {
	checker: PermissionChecker;
	/** Optional callback fired whenever a decision is made (for audit/logging). */
	onDecision?: (info: { toolName: string; decision: "allow" | "ask" | "deny"; reason?: string }) => void;
}

export function createPermissionsExtension(options: PermissionsExtensionOptions) {
	return (pi: ExtensionAPI) => {
		const { checker, onDecision } = options;

		pi.on("session_start", (_event, ctx) => {
			if (!ctx.hasUI) return;
			ctx.ui.setStatus(STATUS_KEY, `permissions: ${checker.mode}`);
		});

		pi.on("tool_call", async (event, ctx) => {
			const action = describeToolAction(event.toolName, event.input);
			const decision = checker.check(action);
			onDecision?.({
				toolName: event.toolName,
				decision: decision.decision,
				reason: "reason" in decision ? decision.reason : undefined,
			});

			if (decision.decision === "allow") return undefined;
			if (decision.decision === "deny") {
				return { block: true, reason: decision.reason };
			}

			// decision === "ask"
			if (!ctx.hasUI) {
				return { block: true, reason: `${decision.reason} (no UI to confirm — denied in non-interactive mode)` };
			}

			const confirmed = await ctx.ui.confirm(
				`Permission required for "${event.toolName}"`,
				`${decision.reason}\n\nAllow this tool call?`,
			);
			if (!confirmed) {
				return { block: true, reason: "User denied via permission prompt." };
			}
			return undefined;
		});

		// Re-evaluate when the user changes mode mid-session via /permission-mode
		pi.registerCommand("permission-mode", {
			description: "Switch permission mode (auto/yolo | plan)",
			async handler(args, ctx) {
				const trimmed = args.trim();
				if (trimmed.length === 0) {
					ctx.ui.notify(`Current mode: ${checker.mode}`, "info");
					return;
				}
				const mode = normalizePermissionMode(trimmed);
				if (!mode) {
					ctx.ui.notify(`Invalid mode "${trimmed}". Use auto/yolo | plan.`, "warning");
					return;
				}
				checker.updateMode(mode);
				ctx.ui.setStatus(STATUS_KEY, `permissions: ${mode}`);
				ctx.ui.notify(`Permission mode → ${mode}`, "info");
			},
		});
	};
}

/** Default permission settings: yolo/auto mode, no checks. */
export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
	mode: "auto",
};
