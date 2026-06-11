/**
 * PermissionChecker — evaluates whether a tool/command is allowed under the
 * configured permission mode and rule set.
 *
 * The checker is pure / synchronous.
 * - plan:   read-only — mutating tools are blocked; reads still honor deny rules.
 * - auto:   guarded — writes/commands run, but built-in + user deny rules apply.
 *
 * The built-in floor can be dropped via `disableBuiltinDefaults` (no-rails);
 * user-authored deny rules still apply.
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
	}

	/**
	 * Whether the built-in deny floor (sensitive paths, dangerous commands) is
	 * active. Off in any mode with `disableBuiltinDefaults`.
	 */
	get builtinsActive(): boolean {
		return !this.ctx.settings.disableBuiltinDefaults;
	}

	private resolvedDenyPaths(includeBuiltins: boolean): readonly PathRule[] {
		const explicit = this.ctx.settings.denyPaths ?? [];
		return includeBuiltins ? [...explicit, ...BUILTIN_SENSITIVE_PATHS] : explicit;
	}

	private resolvedDenyCommands(includeBuiltins: boolean): readonly CommandRule[] {
		const explicit = this.ctx.settings.denyCommands ?? [];
		return includeBuiltins ? [...explicit, ...BUILTIN_DANGEROUS_COMMANDS] : explicit;
	}

	private allowPaths(): readonly PathRule[] {
		return this.ctx.settings.allowPaths ?? [];
	}

	/** Public entry point. */
	check(action: PermissionAction): PermissionDecision {
		const { settings, mode } = this.ctx;

		// Explicit tool-level deny always wins, in every mode.
		if (settings.denyTools?.includes(action.toolName)) {
			return { decision: "deny", reason: `Tool "${action.toolName}" is in denyTools.` };
		}

		if (mode === "plan") {
			return this.checkPlan(action);
		}

		// auto — writes and commands run; deny rules gate them.
		// allowTools is an explicit, deliberate bypass: skip all further checks.
		if (settings.allowTools?.includes(action.toolName)) {
			return { decision: "allow" };
		}

		const builtins = this.builtinsActive;

		if (action.type === "write" || action.type === "read") {
			const denyTarget = this.firstMatchingPath(this.resolvedDenyPaths(builtins), action.paths, action.toolName);
			if (denyTarget) return denyReasonForPath(denyTarget);
		}
		if (action.type === "exec") {
			const denyCmd = findMatchingCommandRule(this.resolvedDenyCommands(builtins), action.command);
			if (denyCmd) {
				return {
					decision: "deny",
					reason: denyCmd.reason ?? `Command matches deny rule "${denyCmd.pattern}".`,
				};
			}
		}
		if (action.type === "write" || action.type === "read") {
			const allowMatch = this.firstMatchingPath(this.allowPaths(), action.paths, action.toolName);
			if (allowMatch) return { decision: "allow" };
		}

		return { decision: "allow" };
	}

	/** Read-only mode: block mutations, still apply read deny/allow rules. */
	private checkPlan(action: PermissionAction): PermissionDecision {
		if (action.type === "write" || action.type === "exec") {
			return { decision: "deny", reason: `Plan mode is read-only — tool "${action.toolName}" is blocked.` };
		}
		if (action.type === "tool" && MUTATING_TOOLS.has(action.toolName)) {
			return { decision: "deny", reason: `Plan mode is read-only — tool "${action.toolName}" is blocked.` };
		}

		if (this.ctx.settings.allowTools?.includes(action.toolName)) {
			return { decision: "allow" };
		}

		if (action.type === "read") {
			const denyTarget = this.firstMatchingPath(
				this.resolvedDenyPaths(this.builtinsActive),
				action.paths,
				action.toolName,
			);
			if (denyTarget) return denyReasonForPath(denyTarget);

			const allowMatch = this.firstMatchingPath(this.allowPaths(), action.paths, action.toolName);
			if (allowMatch) return { decision: "allow" };
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

function denyReasonForPath(denyTarget: { rule: PathRule; matchedPath: string }): PermissionDecision {
	return {
		decision: "deny",
		reason: denyTarget.rule.reason
			? `${denyTarget.rule.reason} (${denyTarget.matchedPath})`
			: `Path "${denyTarget.matchedPath}" matches deny rule "${denyTarget.rule.glob}".`,
	};
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
