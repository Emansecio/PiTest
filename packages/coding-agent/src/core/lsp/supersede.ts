/**
 * Context-economy fingerprints for readonly `lsp` tool calls. Only navigation and
 * diagnostics actions supersede — mutating actions (rename, rename_file, applied
 * code_actions) and escape hatches (request, reload) keep every result.
 */

/** Readonly LSP actions whose repeated identical calls supersede older results. */
export const LSP_SUPERSEDE_READONLY_ACTIONS = new Set([
	"diagnostics",
	"definition",
	"type_definition",
	"implementation",
	"references",
	"hover",
	"symbols",
	"code_actions",
	"capabilities",
	"status",
]);

function stableLspArg(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
	if (typeof value === "string") return value;
	if (typeof value === "boolean") return value ? "1" : "0";
	return "";
}

/**
 * Resource key for superseding stale `lsp` tool results. Returns undefined for
 * mutating or non-deterministic actions so compaction never collapses renames.
 */
export function lspSupersededResourceKey(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	const action = typeof record.action === "string" ? record.action : "";
	if (!LSP_SUPERSEDE_READONLY_ACTIONS.has(action)) return undefined;
	// Applied code_actions mutate the workspace — only list/preview mode supersedes.
	if (action === "code_actions" && record.apply === true) return undefined;

	const parts = ["lsp", action];
	const file = stableLspArg(record.file);
	if (file.length > 0) parts.push(file);
	const timeout = stableLspArg(record.timeout);
	if (timeout.length > 0) parts.push(timeout);
	const line = stableLspArg(record.line);
	if (line.length > 0) parts.push(line);
	const symbol = stableLspArg(record.symbol);
	if (symbol.length > 0) parts.push(symbol);
	const query = stableLspArg(record.query);
	if (query.length > 0) parts.push(query);
	return parts.join("\u0000");
}

/** True when a successful `lsp` call may collapse an older identical result. */
export function isLspSupersedeEligible(args: unknown): boolean {
	return lspSupersededResourceKey(args) !== undefined;
}
