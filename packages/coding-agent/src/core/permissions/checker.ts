/**
 * PermissionChecker — evaluates whether a tool/command is allowed under the
 * configured permission mode and rule set.
 *
 * The checker is pure / synchronous.
 * - plan:   read-only — mutating tools are blocked; reads still honor deny rules.
 * - ask:    read-only — the SAME gate as plan (they differ only in prompt posture,
 *           see `ask-mode-prompt.ts`); deny reasons name the active mode.
 * - auto:   guarded — writes/commands run, but built-in + user deny rules apply.
 * - confirm: the SAME chain as auto with a different terminal — see `checkConfirm`.
 *           Mutations that no allowlist covers resolve to `{ decision: "confirm" }`,
 *           which the caller turns into a human prompt (interactive) or a deny
 *           (headless). Reads are untouched.
 *
 * The built-in floor can be dropped via `disableBuiltinDefaults` (no-rails);
 * user-authored deny rules still apply.
 *
 * Orthogonal to all of the above, `allowlistOnly` (fail-closed CI preset) flips
 * auto's terminal from `allow` to `deny` for anything outside the allowlists —
 * see `checkAllowlistOnly`. It never prompts and never changes the mode, and it
 * wins over `confirm` when both are on (CI must never park on a prompt).
 */

import { truncateWithEllipsis } from "../../utils/surrogate.ts";
import { COORDINATOR_TOOL_NAMES } from "../coordinator/brand.ts";
import { LruMap } from "../lru-map.ts";
import { createRegexTestDeadline } from "../regex-budget.ts";
import { PATH_KEY_ALIASES } from "../tools/argument-prep.ts";
import { findMatchingCommandRule, findMatchingGlob, normalizeTargetPath, wasRegexBudgetExceeded } from "./matcher.ts";
import {
	EXTENSION_TOOL_SIDE_EFFECTS,
	isPlanBlockingSideEffect,
	type PermissionCheckMetadata,
	type PermissionMetadataContext,
	type PermissionMetadataResolver,
	type ToolSideEffect,
} from "./side-effect.ts";
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
	undo: "workspace",
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
	// Read-only: an HTTP GET converted to text. Nothing on disk, no process, no
	// session state — so plan and ask can both use it.
	web_fetch: "none",
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
	pin: "none",
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
	private metadataResolver: PermissionMetadataResolver | undefined;

	constructor(ctx: PermissionContext) {
		this.ctx = ctx;
	}

	get mode(): PermissionMode {
		return this.ctx.mode;
	}

	/**
	 * Working directory the path rules resolve against. Public so the confirm
	 * resolver can build a session `allowPaths` rule from the SAME absolute path
	 * the checker would match ("Allow for session" must not depend on how the
	 * model happened to spell the path).
	 */
	get cwd(): string {
		return this.ctx.cwd;
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

	/** Install the trusted host resolver used before read-only coordinator calls. */
	setMetadataResolver(resolver: PermissionMetadataResolver | undefined): void {
		this.metadataResolver = resolver;
	}

	/** Resolve host authorization facts; resolver failures remain fail-closed. */
	async resolveMetadata(
		toolName: string,
		input: Record<string, unknown>,
		context: PermissionMetadataContext,
	): Promise<PermissionCheckMetadata | undefined> {
		try {
			return await this.metadataResolver?.(toolName, input, context);
		} catch {
			return undefined;
		}
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

	private allowCommands(): readonly CommandRule[] {
		return this.ctx.settings.allowCommands ?? [];
	}

	/**
	 * Whether the fail-closed CI preset is on (`permissions.allowlistOnly`).
	 * Orthogonal to {@link mode} — surfaced in the footer next to it, never in the
	 * mode cycle.
	 */
	get failClosed(): boolean {
		return this.ctx.settings.allowlistOnly === true;
	}

	/** Public entry point. */
	check(action: PermissionAction, metadata?: PermissionCheckMetadata): PermissionDecision {
		const { settings, mode } = this.ctx;

		// Explicit tool-level deny always wins, in every mode (supports globs).
		if (matchesAnyToolRule(settings.denyTools, action.toolName)) {
			return { decision: "deny", reason: `Tool "${action.toolName}" is in denyTools.` };
		}

		// plan and ask share ONE read-only gate — they differ only in the prompt
		// posture injected by the permissions extension, never in enforcement.
		if (mode === "plan" || mode === "ask") {
			return this.checkReadOnly(action, mode, metadata);
		}

		// auto (and confirm, which shares this whole chain) — writes and commands
		// run; deny rules gate them.
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
		// Terminal. Default: auto ends in `allow` — the deny checks above are the whole
		// gate, and no `allowPaths` pass is needed here because a match could never
		// change that outcome (the list is otherwise only consulted in `checkReadOnly`,
		// documented precedence step 6).
		//
		// `allowlistOnly` (fail-closed CI preset) and mode `confirm` each flip exactly
		// this terminal: the order above — denyTools, read-only gate, allowTools
		// bypass, deny rules — is untouched, only what happens when nothing matched
		// changes. allowlistOnly is checked FIRST so it wins when both are on: it
		// exists for headless CI, which must never park on a prompt.
		if (settings.allowlistOnly) return this.checkAllowlistOnly(action);
		if (mode === "confirm") return this.checkConfirm(action);
		return { decision: "allow" };
	}

	/**
	 * Human-in-the-loop terminal for mode `confirm`. Reached only after the full
	 * deny chain has already passed, so this is purely "did the user pre-approve
	 * it?" — the mirror image of {@link checkAllowlistOnly} over the SAME lists:
	 * - `read`  → allow. Deny rules (incl. the sensitive-path floor) already ran;
	 *             confirm gates mutations, not reading.
	 * - `write` → allow without a prompt when EVERY path matches `allowPaths`;
	 *             otherwise confirm. A write that exposed no path still confirms
	 *             (there is nothing to match, and a human can still read the tool).
	 * - `exec`  → allow without a prompt when the command matches `allowCommands`;
	 *             otherwise confirm. A regex budget overrun falls through to the
	 *             prompt rather than to a silent allow.
	 * - `tool`  → side-effect-free tools allow; everything else (workspace/exec/
	 *             agent/opaque, every `mcp__*`) confirms. The one exception is the
	 *             spawn family: a subagent runs headless and cannot raise a prompt
	 *             of its own, so spawning is DENIED rather than confirmed —
	 *             `allowTools` (checked earlier) is the deliberate way in.
	 */
	private checkConfirm(action: PermissionAction): PermissionDecision {
		if (action.type === "read") return { decision: "allow" };

		if (action.type === "write") {
			if (
				action.paths.length > 0 &&
				this.firstNonMatchingPath(this.allowPaths(), action.paths, action.toolName) !== undefined
			) {
				return { decision: "confirm", reason: describeWriteForConfirm(action.toolName, action.paths) };
			}
			if (action.paths.length === 0) {
				return { decision: "confirm", reason: `run "${action.toolName}" (mutating tool, no path exposed)` };
			}
			return { decision: "allow" };
		}

		if (action.type === "exec") {
			const regexDeadline = createRegexTestDeadline();
			const allowCmd = findMatchingCommandRule(this.allowCommands(), action.command, regexDeadline);
			if (allowCmd && !wasRegexBudgetExceeded(regexDeadline)) return { decision: "allow" };
			const command = action.command.trim();
			return {
				decision: "confirm",
				reason: command
					? `run \`${truncateCommandForReason(command)}\``
					: `run "${action.toolName}" (code execution)`,
			};
		}

		if (COORDINATOR_TOOL_NAMES.has(action.toolName)) {
			return { decision: "deny", reason: subagentConfirmDenyReason(action.toolName) };
		}

		// Unclassified tools are opaque (fail-closed into the prompt, not past it).
		const sideEffect = action.toolName.startsWith("mcp__")
			? "opaque"
			: (this.resolveSideEffect(action.toolName) ?? "opaque");
		if (sideEffect === "none") return { decision: "allow" };
		return { decision: "confirm", reason: `run tool "${action.toolName}" (side effect "${sideEffect}")` };
	}

	/**
	 * Fail-closed terminal for `permissions.allowlistOnly` (CI preset). Reached only
	 * after the full deny chain has already passed, so this is purely "is it on an
	 * allowlist?":
	 * - `read`  → allow. Deny rules (incl. the sensitive-path floor) already ran;
	 *             free reads are the point of a CI preset.
	 * - `write` → allow only if EVERY path of the action matches `allowPaths`.
	 * - `exec`  → allow only if the command line matches an `allowCommands` rule.
	 * - `tool`  → allow only side-effect-free tools; anything that touches the
	 *             workspace/shell/subagents (including every `mcp__*`) has exactly
	 *             one way in, `allowTools`, which is checked before this.
	 * An action with nothing to match against (a `write` that exposed no path) is
	 * denied: unverifiable is not the same as safe.
	 */
	private checkAllowlistOnly(action: PermissionAction): PermissionDecision {
		if (action.type === "read") return { decision: "allow" };

		if (action.type === "write") {
			if (action.paths.length === 0) {
				return {
					decision: "deny",
					reason: `${FAIL_CLOSED_PREFIX}tool "${action.toolName}" exposes no path to match against allowPaths.`,
				};
			}
			const unmatched = this.firstNonMatchingPath(this.allowPaths(), action.paths, action.toolName);
			if (unmatched !== undefined) {
				return {
					decision: "deny",
					reason: `${FAIL_CLOSED_PREFIX}path "${unmatched}" does not match any allowPaths rule.`,
				};
			}
			return { decision: "allow" };
		}

		if (action.type === "exec") {
			const regexDeadline = createRegexTestDeadline();
			const allowCmd = findMatchingCommandRule(this.allowCommands(), action.command, regexDeadline);
			// Budget exhaustion resolves the same way as no match: deny.
			if (wasRegexBudgetExceeded(regexDeadline)) {
				return {
					decision: "deny",
					reason: `${FAIL_CLOSED_PREFIX}command allowlist check exceeded regex time budget.`,
				};
			}
			if (allowCmd) return { decision: "allow" };
			return {
				decision: "deny",
				reason: `${FAIL_CLOSED_PREFIX}command "${truncateCommandForReason(action.command)}" does not match any allowCommands rule.`,
			};
		}

		// Unclassified tools are opaque (fail-closed), same posture as plan/ask.
		const sideEffect = this.resolveSideEffect(action.toolName) ?? "opaque";
		if (sideEffect === "none") return { decision: "allow" };
		return {
			decision: "deny",
			reason: `${FAIL_CLOSED_PREFIX}tool "${action.toolName}" (side effect "${sideEffect}") is not in allowTools.`,
		};
	}

	/**
	 * Read-only modes (plan, ask): block mutations, still apply read deny/allow
	 * rules. `mode` only shapes the deny REASON — the model is told which stance it
	 * is actually in, so "switch to auto" advice is never misattributed.
	 */
	private checkReadOnly(
		action: PermissionAction,
		mode: "plan" | "ask",
		metadata?: PermissionCheckMetadata,
	): PermissionDecision {
		const label = mode === "ask" ? "Ask" : "Plan";
		if (action.type === "write" || action.type === "exec") {
			return { decision: "deny", reason: `${label} mode is read-only — tool "${action.toolName}" is blocked.` };
		}

		// MCP is always denied in a read-only mode — allowTools cannot opt in
		// (external servers may mutate; leave the read-only mode to use them).
		if (action.type === "tool" && action.toolName.startsWith("mcp__")) {
			return {
				decision: "deny",
				reason: `${label} mode blocks MCP tools (they may mutate). Switch to auto mode to use "${action.toolName}".`,
			};
		}

		// The host may authorize coordinator delegation only after deriving this
		// fact from the effective child tool catalog and worktree request. Missing
		// metadata remains fail-closed; model-supplied args are never consulted.
		if (
			action.type === "tool" &&
			COORDINATOR_TOOL_NAMES.has(action.toolName) &&
			metadata?.readOnlyDelegation === true
		) {
			return { decision: "allow" };
		}

		if (action.type === "tool") {
			const sideEffect = this.resolveSideEffect(action.toolName);
			// Unclassified tools are treated as opaque (fail-closed).
			if (sideEffect === undefined || isPlanBlockingSideEffect(sideEffect)) {
				return { decision: "deny", reason: `${label} mode is read-only — tool "${action.toolName}" is blocked.` };
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

	/** First resolved path NOT covered by `rules` (fail-closed allowlist check). */
	private firstNonMatchingPath(
		rules: readonly PathRule[],
		paths: readonly string[],
		toolName: string,
	): string | undefined {
		for (const raw of paths) {
			const target = normalizeTargetPath(raw, this.ctx.cwd);
			if (!findMatchingGlob(rules, target, toolName)) return target;
		}
		return undefined;
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

/** Shared prefix so a fail-closed deny is never mistaken for a rule hit. */
const FAIL_CLOSED_PREFIX = "Fail-closed (permissions.allowlistOnly): ";

/**
 * Short, human-facing summary of a pending write for the confirm prompt. Names
 * the first path and counts the rest so a 12-file edit still fits one line.
 */
function describeWriteForConfirm(toolName: string, paths: readonly string[]): string {
	const first = paths[0] ?? "";
	const rest = paths.length - 1;
	const target = rest > 0 ? `"${first}" and ${rest} more path${rest === 1 ? "" : "s"}` : `"${first}"`;
	return `${toolName} → ${target}`;
}

/**
 * Why the spawn family is denied outright in confirm mode. A subagent runs
 * headless — it has no UI of its own to raise an approval prompt — so letting one
 * start would either park forever or silently execute unapproved mutations.
 * `allowTools` (evaluated before this terminal) is the deliberate way in.
 */
export function subagentConfirmDenyReason(toolName: string): string {
	return `Confirm mode blocks subagents — "${toolName}" runs headless and cannot prompt for approval. Switch to auto, or pre-approve via allowTools.`;
}

/**
 * Keep a deny/confirm reason one line even when the command line is huge.
 * Surrogate-safe: a raw `slice` can split an astral pair and emit a lone
 * surrogate into a message that ends up in a prompt or a terminal.
 */
function truncateCommandForReason(command: string): string {
	return truncateWithEllipsis(command.replace(/\s+/g, " ").trim(), 61);
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
