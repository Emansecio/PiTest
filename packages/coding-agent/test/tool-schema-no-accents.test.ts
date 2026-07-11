import { describe, expect, it } from "vitest";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";
import { createMessageToolDefinition } from "../src/core/tools/message.ts";

// Latin accented letters: À-Ö, Ø-ö, ø-ſ (Latin-1 Supplement letters + Latin
// Extended-A). The two gaps (× at ×, ÷ at ÷) and all typographic
// punctuation from   up (em dash —, ellipsis …, arrow →, bullet •) are
// intentionally NOT matched: those are legitimate in English tool descriptions.
// We only flag accented LETTERS, which in practice means a description slipped
// into Portuguese/another Latin language (guards the bash `timeout` regression).
const ACCENTED_LETTER = /[À-ÖØ-öø-ſ]/;

function collectDescriptions(node: unknown, path: string, out: Array<{ path: string; text: string }>): void {
	if (node === null || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (let i = 0; i < node.length; i++) {
			collectDescriptions(node[i], `${path}[${i}]`, out);
		}
		return;
	}
	for (const [key, value] of Object.entries(node)) {
		if (key === "description" && typeof value === "string") {
			out.push({ path: `${path}.description`, text: value });
		} else {
			collectDescriptions(value, `${path}.${key}`, out);
		}
	}
}

describe("tool schema descriptions stay ASCII (no accented letters)", () => {
	const defs = createAllToolDefinitions(process.cwd(), {
		chromeDevtools: { enabled: true },
		lsp: { enabled: true },
		debug: { enabled: true },
	});

	for (const [name, def] of Object.entries(defs)) {
		it(`${name}: tool + parameter descriptions are ASCII-only`, () => {
			const descriptions: Array<{ path: string; text: string }> = [];
			if (typeof def.description === "string") {
				descriptions.push({ path: "description", text: def.description });
			}
			collectDescriptions(def.parameters, "parameters", descriptions);

			const offenders = descriptions.filter((d) => ACCENTED_LETTER.test(d.text));
			const report = offenders.map((o) => `  ${o.path}: ${JSON.stringify(o.text)}`).join("\n");
			expect(
				offenders.length,
				`Tool "${name}" has accented (non-ASCII) letters in a model-facing description. ` +
					`Keep tool schemas in English ASCII (typographic punctuation like — … is fine):\n${report}`,
			).toBe(0);
		});
	}
});

// String-literal action/enum fields are encoded with Type.Enum (emits a compact
// {"enum":[...]} keyword) instead of Type.Union of Type.Literal (which emits the
// verbose {"anyOf":[{const}...]} form). This keeps the model-facing tool prefix
// small. These assertions lock the encoding AND the exact value set per field, so
// a regression back to anyOf — or a dropped/added value — fails loudly.
describe("string-literal schema fields use Type.Enum (compact, not anyOf)", () => {
	const defs = createAllToolDefinitions(process.cwd(), {
		chromeDevtools: { enabled: true },
		lsp: { enabled: true },
		debug: { enabled: true },
	});

	function enumOf(parameters: unknown, field: string): unknown {
		const props = (parameters as { properties?: Record<string, unknown> }).properties ?? {};
		const node = props[field] as { enum?: unknown; anyOf?: unknown } | undefined;
		// Guard against silent regression to the verbose anyOf form.
		expect(node, `field "${field}" missing from schema`).toBeDefined();
		expect(node?.anyOf, `field "${field}" regressed to anyOf (use Type.Enum)`).toBeUndefined();
		return node?.enum;
	}

	const cases: Array<{ tool: string; field: string; values: string[] }> = [
		{
			tool: "debug",
			field: "action",
			values: [
				"launch",
				"attach",
				"set_breakpoint",
				"remove_breakpoint",
				"set_instruction_breakpoint",
				"remove_instruction_breakpoint",
				"data_breakpoint_info",
				"set_data_breakpoint",
				"remove_data_breakpoint",
				"watchpoint_bisect",
				"continue",
				"step_over",
				"step_in",
				"step_out",
				"pause",
				"evaluate",
				"stack_trace",
				"threads",
				"scopes",
				"variables",
				"disassemble",
				"read_memory",
				"write_memory",
				"modules",
				"loaded_sources",
				"custom_request",
				"output",
				"terminate",
				"sessions",
			],
		},
		{ tool: "debug", field: "context", values: ["watch", "repl", "hover", "variables", "clipboard"] },
		{ tool: "debug", field: "access_type", values: ["read", "write", "readWrite"] },
		{
			tool: "lsp",
			field: "action",
			values: [
				"diagnostics",
				"definition",
				"references",
				"hover",
				"symbols",
				"rename",
				"rename_file",
				"code_actions",
				"type_definition",
				"implementation",
				"status",
				"reload",
				"capabilities",
				"request",
			],
		},
		{ tool: "todo", field: "action", values: ["create", "update", "list", "get", "delete", "clear"] },
		{ tool: "todo", field: "status", values: ["pending", "in_progress", "completed"] },
		{ tool: "web_search", field: "provider", values: ["auto", "brave", "tavily", "jina", "perplexity", "exa"] },
		{ tool: "eval", field: "lang", values: ["python", "javascript"] },
		{ tool: "retain", field: "kind", values: ["fact", "decision", "pattern"] },
		{ tool: "resolve", field: "action", values: ["accept", "discard"] },
	];

	for (const { tool, field, values } of cases) {
		it(`${tool}.${field} is a Type.Enum with the expected values`, () => {
			const def = defs[tool as keyof typeof defs];
			expect(def, `tool "${tool}" not found in createAllToolDefinitions`).toBeDefined();
			expect(enumOf(def.parameters, field)).toEqual(values);
		});
	}

	// message is injected per-subagent (needs selfId), so it is not in
	// createAllToolDefinitions — build it directly.
	it("message.op is a Type.Enum with the expected values", () => {
		const def = createMessageToolDefinition(process.cwd(), { selfId: "test-self" });
		expect(enumOf(def.parameters, "op")).toEqual(["send", "list"]);
	});
});
