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

import { LruMap } from "../lru-map.ts";
import { createRegexTestDeadline } from "../regex-budget.ts";
import { PATH_KEY_ALIASES } from "../tools/argument-prep.ts";
import { findMatchingCommandRule, findMatchingGlob, normalizeTargetPath, wasRegexBudgetExceeded } from "./matcher.ts";
import { EXTENSION_TOOL_SIDE_EFFECTS, isPlanBlockingSideEffect, type ToolSideEffect } from "./side-effect.ts";
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

/** `lsp` actions that mutate the workspace (rename a symbol/file). */
const LSP_WRITE_ACTIONS = new Set(["rename", "rename_file"]);

/** `chrome_devtools_*` operations with an observable side effect (navigation, input, upload). */
const CHROME_EFFECT_OPS = new Set([
	"navigate",
	"close_page",
	"click",
	"fill",
	"press_key",
	"hover",
	"select_option",
	"upload_file",
]);

/**
 * Fallback side-effect map for built-in tools when the session has not yet
 * refreshed the checker's lookup. Mirrors TOOL_REGISTRY.sideEffect — keep in
 * sync (tested). Primary classification for write/exec still happens in
 * `describeToolAction`.
 */
export const BUILTIN_TOOL_SIDE_EFFECTS: Readonly<Record<string, ToolSideEffect>> = {
	read: "none",
	bash: "exec",
	edit: "workspace",
	edit_v2: "workspace",
	write: "workspace",
	grep: "none",
	find: "none",
	ls: "none",
	symbol: "none",
	find_symbol: "none",
	repo_map: "none",
	security_surface_map: "none",
	security_static_scan: "none",
	security_http_replay_diff: "exec",
	security_validate_finding: "none",
	security_evidence: "agent",
	search_skills: "none",
	ask: "none",
	resolve: "agent",
	search_tool_bm25: "none",
	ast_grep: "none",
	ast_edit: "workspace",
	web_search: "none",
	eval: "exec",
	code: "exec",
	retain: "agent",
	recall: "none",
	reflect: "none",
	forget: "agent",
	calc: "none",
	recipe: "exec",
	inspect_image: "none",
	render_mermaid: "none",
	goal_complete: "agent",
	todo: "none",
	plan: "none",
	lsp: "none", // dual-mode: mutating actions classified as write in describeToolAction
	debug: "exec",
	chrome_devtools_list_pages: "none",
	chrome_devtools_select_page: "none",
	chrome_devtools_navigate: "workspace",
	chrome_devtools_close_page: "workspace",
	chrome_devtools_evaluate: "exec",
	chrome_devtools_screenshot: "none",
	chrome_devtools_read_console: "none",
	chrome_devtools_read_network: "none",
	chrome_devtools_click: "workspace",
	chrome_devtools_fill: "workspace",
	chrome_devtools_press_key: "workspace",
	chrome_devtools_get_text: "none",
	chrome_devtools_wait_for: "none",
	chrome_devtools_hover: "workspace",
	chrome_devtools_select_option: "workspace",
	chrome_devtools_upload_file: "workspace",
	chrome_devtools_snapshot: "none",
	chrome_devtools_get_network_body: "none",
	chrome_devtools_element_to_source: "none",
	preview: "exec",
	recall_tool_output: "none",
	recall_history: "none",
	...EXTENSION_TOOL_SIDE_EFFECTS,
};

export interface PermissionContext {
	cwd: string;
	mode: PermissionMode;
	settings: PermissionSettings;
	/**
	 * Optional live lookup (session tool registry). Falls back to
	 * {@link BUILTIN_TOOL_SIDE_EFFECTS} when a name is missing.
	 */
	getSideEffect?: (toolName: string) => ToolSideEffect | undefined;
}

/**
 * Match a tool name against an allow/deny rule list, supporting `*`/`?` globs so
 * a whole MCP server can be gated at once (e.g. `mcp__github__*`). Exact names
 * still match exactly (backward compatible).
 */
export function matchesAnyToolRule(rules: readonly string[] | undefined, toolName: string): boolean {
	if (!rules || rules.length === 0) return false;
	for (const rule of rules) {
		if (rule === toolName) return true;
		if ((rule.includes("*") || rule.includes("?")) && toolPatternToRegExp(rule).test(toolName)) return true;
	}
	return false;
}

const toolPatternCache = new LruMap<string, RegExp>(256);
function toolPatternToRegExp(pattern: string): RegExp {
	let re = toolPatternCache.get(pattern);
	if (!re) {
		const escaped = pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*/g, ".*")
			.replace(/\?/g, ".");
		re = new RegExp(`^${escaped}$`);
		toolPatternCache.set(pattern, re);
	}
	return re;
}

export class PermissionChecker {
	private ctx: PermissionContext;
	/** Session-refreshed side-effect overrides (extension tools, opaque defaults). */
	private sideEffectOverrides = new Map<string, ToolSideEffect>();

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
	 * Replace the live side-effect lookup from the session tool registry.
	 * Names not listed still fall back to {@link BUILTIN_TOOL_SIDE_EFFECTS}.
	 */
	setToolSideEffects(entries: Iterable<readonly [string, ToolSideEffect]>): void {
		this.sideEffectOverrides = new Map(entries);
	}

	/** Resolve side-effect class for a tool name (overrides → ctx → builtins). */
	resolveSideEffect(toolName: string): ToolSideEffect | undefined {
		const overridden = this.sideEffectOverrides.get(toolName);
		if (overridden !== undefined) return overridden;
		const fromCtx = this.ctx.getSideEffect?.(toolName);
		if (fromCtx !== undefined) return fromCtx;
		return BUILTIN_TOOL_SIDE_EFFECTS[toolName];
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

		// Explicit tool-level deny always wins, in every mode (supports globs).
		if (matchesAnyToolRule(settings.denyTools, action.toolName)) {
			return { decision: "deny", reason: `Tool "${action.toolName}" is in denyTools.` };
		}

		if (mode === "plan") {
			return this.checkPlan(action);
		}

		// auto — writes and commands run; deny rules gate them.
		// allowTools is an explicit, deliberate bypass: skip all further checks.
		if (matchesAnyToolRule(settings.allowTools, action.toolName)) {
			return { decision: "allow" };
		}

		const builtins = this.builtinsActive;

		if (action.type === "write" || action.type === "read") {
			const denyTarget = this.firstMatchingPath(this.resolvedDenyPaths(builtins), action.paths, action.toolName);
			if (denyTarget) return denyReasonForPath(denyTarget);
		}
		if (action.type === "exec") {
			const regexDeadline = createRegexTestDeadline();
			const denyCmd = findMatchingCommandRule(this.resolvedDenyCommands(builtins), action.command, regexDeadline);
			if (wasRegexBudgetExceeded(regexDeadline)) {
				return {
					decision: "deny",
					reason: "Command permission check exceeded regex time budget (fail-closed).",
				};
			}
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

		// MCP is always denied in plan — allowTools cannot opt in (external servers
		// may mutate; leave plan mode to use them).
		if (action.type === "tool" && action.toolName.startsWith("mcp__")) {
			return {
				decision: "deny",
				reason: `Plan mode blocks MCP tools (they may mutate). Switch to auto mode to use "${action.toolName}".`,
			};
		}

		if (action.type === "tool") {
			const sideEffect = this.resolveSideEffect(action.toolName);
			// Unclassified tools are treated as opaque (fail-closed).
			if (sideEffect === undefined || isPlanBlockingSideEffect(sideEffect)) {
				return { decision: "deny", reason: `Plan mode is read-only — tool "${action.toolName}" is blocked.` };
			}
		}

		if (matchesAnyToolRule(this.ctx.settings.allowTools, action.toolName)) {
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
			const paths = collectPathFields(input, ["directory"]);
			return { type: "read", toolName, paths };
		}
		case "edit":
		case "edit_v2":
		case "ast_edit": {
			const paths = collectPathFields(input);
			return { type: "write", toolName, paths };
		}
		case "write": {
			const paths = collectPathFields(input);
			return { type: "write", toolName, paths };
		}
		case "bash": {
			const command = typeof input.command === "string" ? input.command : "";
			return { type: "exec", toolName, command };
		}
		// Code-execution / recipe / preview tools: classified as `exec` so plan mode
		// (read-only) blocks them. The command body is left empty — plan blocks on the
		// action type alone, and auto-mode deny rules target shell command lines, not
		// code/program bodies, so auto behavior is unchanged.
		case "eval":
		case "debug":
		case "code":
		case "recipe":
		case "preview":
			return { type: "exec", toolName, command: "" };
		// Memory / discovery / coordinator mutators: opaque `tool` actions gated by
		// sideEffect (agent/workspace) in checkPlan.
		case "retain":
		case "forget":
		case "resolve":
		case "task":
		case "parallel":
		case "fanout":
		case "goal_complete":
		case "memory_append":
			return { type: "tool", toolName, args: input };
		// `lsp` is dual-mode: only the workspace-mutating actions are writes. Read
		// actions (diagnostics, definition, hover, list-only code_actions, …) stay
		// `tool` so auto behavior is unchanged and plan still allows read-only navigation.
		case "lsp": {
			const action = typeof input.action === "string" ? input.action : "";
			const mutates = LSP_WRITE_ACTIONS.has(action) || (action === "code_actions" && input.apply === true);
			if (mutates) {
				return { type: "write", toolName, paths: collectPathFields(input) };
			}
			return { type: "tool", toolName, args: input };
		}
		default: {
			// `chrome_devtools_*` is dual-mode: `evaluate` runs arbitrary JS, and the
			// interaction ops (navigate/click/fill/…) have observable side effects, so
			// plan mode must block them. Read ops (screenshot, snapshot, get_text, …)
			// fall through to `tool`.
			if (toolName.startsWith("chrome_devtools_")) {
				const op = toolName.slice("chrome_devtools_".length);
				if (op === "evaluate") return { type: "exec", toolName, command: "" };
				if (CHROME_EFFECT_OPS.has(op)) return { type: "write", toolName, paths: [] };
			}
			return { type: "tool", toolName, args: input };
		}
	}
}

/**
 * Canonical path key plus every alias that maps to it. Derived from the SAME
 * source of truth (`PATH_KEY_ALIASES`) the tool_call guards use, so the deny
 * floor sees the path no matter which OpenAI-style alias
 * (file_path/filepath/filename/file) the model emitted.
 */
const PATH_KEYS: readonly string[] = ["path", ...Object.keys(PATH_KEY_ALIASES)];

/**
 * Collect every path candidate from raw (pre-normalization) tool input for the
 * deny floor. Defensive posture: gather ALL aliased path keys present (not just
 * the coalesce "winner"), plus any `extraFields` (e.g. `directory` for ls/find),
 * and apply the same path aliases inside each `edits[]` element. Over-collecting
 * here can only ever cause an extra (correct) deny match — never a leak.
 */
function collectPathFields(input: Record<string, unknown>, extraFields: readonly string[] = []): string[] {
	const paths: string[] = [];
	const pushFrom = (rec: Record<string, unknown>, fields: readonly string[]): void => {
		for (const field of fields) {
			const value = rec[field];
			if (typeof value === "string" && value.length > 0) {
				paths.push(value);
			}
		}
	};
	pushFrom(input, [...PATH_KEYS, ...extraFields]);
	// Edit tool has an "edits[]" array with per-edit overrides — collect those too,
	// honoring the same path aliases on each element.
	if (Array.isArray(input.edits)) {
		for (const item of input.edits) {
			if (item && typeof item === "object") {
				pushFrom(item as Record<string, unknown>, PATH_KEYS);
			}
		}
	}
	return paths;
}
