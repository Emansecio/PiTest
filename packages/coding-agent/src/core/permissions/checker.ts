/**
 * PermissionChecker — evaluates whether a tool/command is allowed under the
 * configured permission mode and rule set.
 *
 * The checker is pure / synchronous. Auto/yolo mode skips all checks; plan mode
 * blocks mutating tools and still applies configured read restrictions.
 */

import { findMatchingGlob, normalizeTargetPath } from "./matcher.ts";
import {
	BUILTIN_SENSITIVE_PATHS,
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

	/** Public entry point. */
	check(action: PermissionAction): PermissionDecision {
		if (this.ctx.mode === "auto") {
			return { decision: "allow" };
		}

		const { settings } = this.ctx;

		// Tool-level deny still applies in plan mode for read-only tools.
		if (settings.denyTools?.includes(action.toolName)) {
			return { decision: "deny", reason: `Tool "${action.toolName}" is in denyTools.` };
		}

		// Plan mode: block any mutating action before allow rules can bypass read-only mode.
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

		if (settings.allowTools?.includes(action.toolName)) {
			return { decision: "allow" };
		}

		// Path-based checks for read tools that remain available in plan mode.
		if (action.type === "read") {
			const denyTarget = this.firstMatchingPath(this.denyPaths(), action.paths, action.toolName);
			if (denyTarget) {
				return {
					decision: "deny",
					reason: denyTarget.rule.reason
						? `${denyTarget.rule.reason} (${denyTarget.matchedPath})`
						: `Path "${denyTarget.matchedPath}" matches deny rule "${denyTarget.rule.glob}".`,
				};
			}

			const allowMatch = this.firstMatchingPath(this.allowPaths(), action.paths, action.toolName);
			if (allowMatch) {
				return { decision: "allow" };
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
