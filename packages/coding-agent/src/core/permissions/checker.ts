/**
 * PermissionChecker — evaluates whether a tool/command is allowed under the
 * configured permission mode and rule set.
 *
 * The checker is pure / synchronous. Interactive prompting is wired by the
 * built-in permissions extension that consumes its decisions.
 */

import { findMatchingCommandRule, findMatchingGlob, normalizeTargetPath } from "./matcher.ts";
import {
	BUILTIN_DANGEROUS_COMMANDS,
	BUILTIN_SENSITIVE_PATHS,
	type CommandRule,
	type PathRule,
	type PermissionAction,
	type PermissionDecision,
	type PermissionMode,
	type PermissionSettings,
} from "./types.ts";

/** Built-in tools considered mutating for the purpose of mode "plan". */
const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);

export interface PermissionContext {
	cwd: string;
	mode: PermissionMode;
	settings: PermissionSettings;
}

export class PermissionChecker {
	private ctx: PermissionContext;
	private _cachedDenyPaths: readonly PathRule[] | undefined;
	private _cachedDenyCommands: readonly CommandRule[] | undefined;
	private _settingsRef: PermissionSettings | undefined;

	constructor(ctx: PermissionContext) {
		this.ctx = ctx;
	}

	get mode(): PermissionMode {
		return this.ctx.mode;
	}

	get settings(): PermissionSettings {
		return this.ctx.settings;
	}

	updateMode(mode: PermissionMode): void {
		this.ctx = { ...this.ctx, mode };
	}

	updateSettings(settings: PermissionSettings): void {
		this.ctx = { ...this.ctx, settings };
		this._settingsRef = undefined;
	}

	private invalidateCacheIfNeeded(): void {
		if (this._settingsRef !== this.ctx.settings) {
			this._cachedDenyPaths = undefined;
			this._cachedDenyCommands = undefined;
			this._settingsRef = this.ctx.settings;
		}
	}

	private allowPaths(): readonly PathRule[] {
		return this.ctx.settings.allowPaths ?? [];
	}

	private denyPaths(): readonly PathRule[] {
		this.invalidateCacheIfNeeded();
		if (!this._cachedDenyPaths) {
			const builtins = this.ctx.settings.disableBuiltinDefaults ? [] : BUILTIN_SENSITIVE_PATHS;
			this._cachedDenyPaths = [...(this.ctx.settings.denyPaths ?? []), ...builtins];
		}
		return this._cachedDenyPaths;
	}

	private askPaths(): readonly PathRule[] {
		return this.ctx.settings.askPaths ?? [];
	}

	private denyCommands(): readonly CommandRule[] {
		this.invalidateCacheIfNeeded();
		if (!this._cachedDenyCommands) {
			const builtins = this.ctx.settings.disableBuiltinDefaults ? [] : BUILTIN_DANGEROUS_COMMANDS;
			this._cachedDenyCommands = [...(this.ctx.settings.denyCommands ?? []), ...builtins];
		}
		return this._cachedDenyCommands;
	}

	private askCommands(): readonly CommandRule[] {
		return this.ctx.settings.askCommands ?? [];
	}

	/** Public entry point. */
	check(action: PermissionAction): PermissionDecision {
		const { settings } = this.ctx;

		// Tool-level allow / deny short-circuits.
		if (settings.denyTools?.includes(action.toolName)) {
			return { decision: "deny", reason: `Tool "${action.toolName}" is in denyTools.` };
		}
		if (settings.allowTools?.includes(action.toolName)) {
			return { decision: "allow" };
		}

		// Plan mode: block any mutating action.
		if (this.ctx.mode === "plan") {
			if (action.type === "write" || action.type === "exec") {
				return {
					decision: "deny",
					reason: `Plan mode is read-only — tool "${action.toolName}" is blocked.`,
				};
			}
			if (action.type === "tool" && MUTATING_TOOLS.has(action.toolName)) {
				return {
					decision: "deny",
					reason: `Plan mode is read-only — tool "${action.toolName}" is blocked.`,
				};
			}
		}

		// Path-based checks.
		if (action.type === "read" || action.type === "write") {
			const denyTarget = this.firstMatchingPath(this.denyPaths(), action.paths, action.toolName);
			if (denyTarget) {
				return {
					decision: "deny",
					reason: denyTarget.rule.reason
						? `${denyTarget.rule.reason} (${denyTarget.matchedPath})`
						: `Path "${denyTarget.matchedPath}" matches deny rule "${denyTarget.rule.glob}".`,
				};
			}

			// Writes are higher risk than reads — block sensitive paths even when matched only by the read-rule set
			// is not needed (deny applies to both). Allowed paths skip ask.
			const allowMatch = this.firstMatchingPath(this.allowPaths(), action.paths, action.toolName);
			if (allowMatch) {
				return { decision: "allow" };
			}

			// Ask only in default mode for path matches; auto mode skips prompts.
			if (this.ctx.mode === "default") {
				const askMatch = this.firstMatchingPath(this.askPaths(), action.paths, action.toolName);
				if (askMatch) {
					return {
						decision: "ask",
						reason: askMatch.rule.reason
							? `${askMatch.rule.reason} (${askMatch.matchedPath})`
							: `Path "${askMatch.matchedPath}" matches ask rule "${askMatch.rule.glob}".`,
					};
				}
			}
		}

		// Command-based checks.
		if (action.type === "exec") {
			const denyMatch = findMatchingCommandRule(this.denyCommands(), action.command);
			if (denyMatch) {
				return {
					decision: "deny",
					reason: denyMatch.reason
						? `${denyMatch.reason}`
						: `Command matches deny pattern /${denyMatch.pattern}/.`,
				};
			}
			if (this.ctx.mode === "default") {
				const askMatch = findMatchingCommandRule(this.askCommands(), action.command);
				if (askMatch) {
					return {
						decision: "ask",
						reason: askMatch.reason ?? `Command matches ask pattern /${askMatch.pattern}/.`,
					};
				}
			}
		}

		return { decision: "allow" };
	}

	private firstMatchingPath(
		rules: readonly PathRule[],
		paths: readonly string[],
		toolName: string,
	): { rule: PathRule; matchedPath: string } | undefined {
		for (const raw of paths) {
			const target = normalizeTargetPath(raw, this.ctx.cwd);
			const rule = findMatchingGlob(rules, target, toolName);
			if (rule) {
				return { rule, matchedPath: target };
			}
		}
		return undefined;
	}
}

/** Map a tool name + input to a PermissionAction. */
export function describeToolAction(toolName: string, input: Record<string, unknown>): PermissionAction {
	switch (toolName) {
		case "read":
		case "grep":
		case "find":
		case "ls": {
			const paths = collectPathFields(input, ["file", "path", "directory"]);
			return { type: "read", toolName, paths };
		}
		case "edit": {
			const paths = collectPathFields(input, ["file"]);
			return { type: "write", toolName, paths };
		}
		case "write": {
			const paths = collectPathFields(input, ["file", "path"]);
			return { type: "write", toolName, paths };
		}
		case "bash": {
			const command = typeof input.command === "string" ? input.command : "";
			return { type: "exec", toolName, command };
		}
		default:
			return { type: "tool", toolName, args: input };
	}
}

function collectPathFields(input: Record<string, unknown>, fields: readonly string[]): string[] {
	const paths: string[] = [];
	for (const field of fields) {
		const value = input[field];
		if (typeof value === "string" && value.length > 0) {
			paths.push(value);
		}
	}
	// Edit tool has an "edits[]" array with per-edit overrides — collect those too.
	if (Array.isArray(input.edits)) {
		for (const item of input.edits) {
			if (item && typeof item === "object") {
				const itemRec = item as Record<string, unknown>;
				if (typeof itemRec.file === "string" && itemRec.file.length > 0) {
					paths.push(itemRec.file);
				}
			}
		}
	}
	return paths;
}
