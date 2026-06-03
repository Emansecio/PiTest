/**
 * `render_mermaid` tool — converts a Mermaid flowchart source into terminal
 * ASCII art. Supports the simple node + edge grammar only; anything more
 * complex falls back to returning the original source in a fenced code block.
 *
 * Grammar handled:
 *   graph TD | graph LR | flowchart TD | flowchart LR (etc.)
 *   nodes:   id, id[label], id(label), id{label}
 *   edges:   a --> b, a --- b, a -->|label| b
 *
 * Sequence diagrams, class diagrams, state diagrams, etc. fall back gracefully.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const renderMermaidSchema = Type.Object(
	{
		source: Type.String({ description: "Mermaid diagram source." }),
		max_width: Type.Optional(
			Type.Number({
				description: "Maximum render width in characters. Default 80.",
				minimum: 20,
				maximum: 240,
			}),
		),
	},
	{ additionalProperties: false },
);

export type RenderMermaidToolInput = Static<typeof renderMermaidSchema>;

export interface RenderMermaidToolDetails {
	mode: "ascii" | "fallback";
	direction: "TD" | "LR" | "unknown";
	nodeCount: number;
	edgeCount: number;
}

export interface RenderMermaidToolOptions {}

interface NodeInfo {
	id: string;
	label: string;
	shape: "square" | "round" | "diamond" | "bare";
}

interface EdgeInfo {
	from: string;
	to: string;
	label?: string;
	style: "solid" | "dashed";
}

interface ParsedDiagram {
	direction: "TD" | "LR";
	nodes: Map<string, NodeInfo>;
	edges: EdgeInfo[];
}

const SUPPORTED_HEADER = /^\s*(graph|flowchart)\s+(TD|TB|LR|RL|BT)\s*$/i;
const UNSUPPORTED_HEADERS = [
	"sequenceDiagram",
	"classDiagram",
	"stateDiagram",
	"stateDiagram-v2",
	"erDiagram",
	"journey",
	"gantt",
	"pie",
	"gitGraph",
	"mindmap",
	"timeline",
	"quadrantChart",
	"requirementDiagram",
	"C4Context",
	"C4Container",
	"C4Component",
	"C4Dynamic",
	"C4Deployment",
];

function fallback(source: string): string {
	return `Mermaid renderer supports simple flowcharts only. Source preserved as a fenced code block:\n\n\`\`\`mermaid\n${source}\n\`\`\``;
}

function stripComment(line: string): string {
	const idx = line.indexOf("%%");
	if (idx >= 0) return line.slice(0, idx);
	return line;
}

/**
 * Try to parse a Mermaid flowchart. Returns null when the source is too
 * complex or doesn't match the simple grammar.
 */
function tryParse(source: string): ParsedDiagram | null {
	const rawLines = source.split(/\r?\n/);
	const lines: string[] = [];
	for (const raw of rawLines) {
		const cleaned = stripComment(raw).trim();
		if (cleaned) lines.push(cleaned);
	}
	if (lines.length === 0) return null;

	const header = lines[0]!;
	for (const u of UNSUPPORTED_HEADERS) {
		if (header.toLowerCase().startsWith(u.toLowerCase())) return null;
	}
	const m = header.match(SUPPORTED_HEADER);
	if (!m) return null;
	const dirToken = m[2]!.toUpperCase();
	const direction: "TD" | "LR" = dirToken === "LR" || dirToken === "RL" ? "LR" : "TD";

	const nodes = new Map<string, NodeInfo>();
	const edges: EdgeInfo[] = [];

	// Reject lines containing subgraph blocks, class defs, style, click, etc.
	const unsupportedKeywords = /^(subgraph|end|classDef|class\s|style\s|click\s|linkStyle\s|direction\s)/i;

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!;
		if (unsupportedKeywords.test(line)) {
			return null;
		}
		if (!parseStatement(line, nodes, edges)) {
			return null;
		}
	}

	if (nodes.size === 0 && edges.length === 0) return null;

	return { direction, nodes, edges };
}

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const NODE_RE = new RegExp(`^(${IDENT})(?:\\[([^\\]]*)\\]|\\(([^)]*)\\)|\\{([^}]*)\\})?$`);
const EDGE_RE = /^(-{2,3}>|-{3,})(?:\|([^|]*)\|)?$/;

/** Parse a single statement (possibly chained: a-->b-->c). Returns false on syntax error. */
function parseStatement(line: string, nodes: Map<string, NodeInfo>, edges: EdgeInfo[]): boolean {
	const trimmed = line.replace(/;$/, "").trim();
	if (!trimmed) return true;

	// Tokenize the line into nodes and edges. We split on whitespace runs but keep
	// bracket content intact.
	const tokens = tokenizeStatement(trimmed);
	if (!tokens) return false;

	// Pattern: NODE (EDGE NODE)*  → either a chain of edges or a single node.
	let i = 0;
	let prevNodeId: string | null = null;
	let pendingEdge: { style: "solid" | "dashed"; label?: string; isArrow: boolean } | null = null;

	while (i < tokens.length) {
		const tok = tokens[i]!;
		if (tok.kind === "node") {
			const info = parseNodeToken(tok.text);
			if (!info) return false;
			if (!nodes.has(info.id) || info.shape !== "bare") {
				const existing = nodes.get(info.id);
				if (!existing || existing.shape === "bare") {
					nodes.set(info.id, info);
				}
			}
			if (prevNodeId && pendingEdge) {
				edges.push({
					from: prevNodeId,
					to: info.id,
					label: pendingEdge.label,
					style: pendingEdge.style,
				});
				pendingEdge = null;
			}
			prevNodeId = info.id;
		} else if (tok.kind === "edge") {
			if (!prevNodeId) return false;
			const e = parseEdgeToken(tok.text);
			if (!e) return false;
			pendingEdge = e;
		} else {
			return false;
		}
		i++;
	}

	// A trailing pending edge with no destination is malformed.
	if (pendingEdge) return false;
	return true;
}

interface StmtTok {
	kind: "node" | "edge";
	text: string;
}

function tokenizeStatement(line: string): StmtTok[] | null {
	const out: StmtTok[] = [];
	let i = 0;
	while (i < line.length) {
		const c = line[i]!;
		if (c === " " || c === "\t") {
			i++;
			continue;
		}
		// Edge: starts with '-' (and not part of an identifier)
		if (c === "-") {
			let j = i;
			while (j < line.length && line[j] === "-") j++;
			if (line[j] === ">") j++;
			let edgeText = line.slice(i, j);
			// Optional label |...|
			if (line[j] === "|") {
				const close = line.indexOf("|", j + 1);
				if (close < 0) return null;
				edgeText += line.slice(j, close + 1);
				j = close + 1;
			}
			out.push({ kind: "edge", text: edgeText });
			i = j;
			continue;
		}
		// Node: identifier possibly followed by [..], (..), or {..}
		if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") {
			let j = i;
			while (
				j < line.length &&
				((line[j]! >= "a" && line[j]! <= "z") ||
					(line[j]! >= "A" && line[j]! <= "Z") ||
					(line[j]! >= "0" && line[j]! <= "9") ||
					line[j] === "_")
			) {
				j++;
			}
			let bracket: [string, string] | null = null;
			if (line[j] === "[") bracket = ["[", "]"];
			else if (line[j] === "(") bracket = ["(", ")"];
			else if (line[j] === "{") bracket = ["{", "}"];
			if (bracket) {
				const close = line.indexOf(bracket[1], j + 1);
				if (close < 0) return null;
				j = close + 1;
			}
			out.push({ kind: "node", text: line.slice(i, j) });
			i = j;
			continue;
		}
		return null;
	}
	return out;
}

function parseNodeToken(text: string): NodeInfo | null {
	const m = text.match(NODE_RE);
	if (!m) return null;
	const id = m[1]!;
	if (m[2] !== undefined) return { id, label: m[2], shape: "square" };
	if (m[3] !== undefined) return { id, label: m[3], shape: "round" };
	if (m[4] !== undefined) return { id, label: m[4], shape: "diamond" };
	return { id, label: id, shape: "bare" };
}

function parseEdgeToken(text: string): { style: "solid" | "dashed"; label?: string; isArrow: boolean } | null {
	// strip optional label
	let bare = text;
	let label: string | undefined;
	const barIdx = text.indexOf("|");
	if (barIdx >= 0) {
		const close = text.indexOf("|", barIdx + 1);
		if (close < 0) return null;
		label = text.slice(barIdx + 1, close);
		bare = text.slice(0, barIdx);
	}
	if (!EDGE_RE.test(`${bare}${label !== undefined ? `|${label}|` : ""}`)) return null;
	const isArrow = bare.endsWith(">");
	return { style: "solid", label, isArrow };
}

// ===== Rendering =====

function renderNodeBox(info: NodeInfo): string {
	const inner = info.label || info.id;
	switch (info.shape) {
		case "square":
			return `[${inner}]`;
		case "round":
			return `(${inner})`;
		case "diamond":
			return `<${inner}>`;
		case "bare":
			return inner;
	}
}

/** Topological layering for a DAG-ish flowchart. Cycles broken by best-effort. */
function layerNodes(diag: ParsedDiagram): string[][] {
	const inDeg = new Map<string, number>();
	const adj = new Map<string, string[]>();
	for (const id of diag.nodes.keys()) {
		inDeg.set(id, 0);
		adj.set(id, []);
	}
	for (const e of diag.edges) {
		if (!inDeg.has(e.to)) inDeg.set(e.to, 0);
		if (!inDeg.has(e.from)) inDeg.set(e.from, 0);
		if (!adj.has(e.from)) adj.set(e.from, []);
		adj.get(e.from)!.push(e.to);
		inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
	}
	const layers: string[][] = [];
	const remaining = new Set(inDeg.keys());
	const layerOf = new Map<string, number>();
	while (remaining.size > 0) {
		const layer: string[] = [];
		for (const id of remaining) {
			if ((inDeg.get(id) ?? 0) === 0) layer.push(id);
		}
		if (layer.length === 0) {
			// cycle: pick the lowest-in-degree remaining node
			let best: string | undefined;
			let bestDeg = Infinity;
			for (const id of remaining) {
				const d = inDeg.get(id) ?? 0;
				if (d < bestDeg) {
					best = id;
					bestDeg = d;
				}
			}
			if (best === undefined) break;
			layer.push(best);
		}
		for (const id of layer) {
			remaining.delete(id);
			layerOf.set(id, layers.length);
			for (const nxt of adj.get(id) ?? []) {
				inDeg.set(nxt, (inDeg.get(nxt) ?? 0) - 1);
			}
		}
		layers.push(layer);
	}
	return layers;
}

function renderHorizontal(diag: ParsedDiagram, maxWidth: number): string {
	const layers = layerNodes(diag);
	const out: string[] = [];

	// Render layer-by-layer: nodes joined by '--->' arrows from left to right
	// when an edge directly connects adjacent layers; vertical drops emitted
	// below for cross-layer or branching edges.
	for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
		const layer = layers[layerIdx]!;
		const boxes = layer.map((id) => renderNodeBox(diag.nodes.get(id) ?? { id, label: id, shape: "bare" }));
		out.push(boxes.join("  "));
	}

	// Append edges that connect across layers (more than one step) or branch
	// out from a node within the same layer.
	const linear =
		layers.length > 1 &&
		diag.edges.every((e) => {
			const a = layerIndexOf(layers, e.from);
			const b = layerIndexOf(layers, e.to);
			return a >= 0 && b === a + 1;
		});

	if (linear) {
		// Render as one line: [A] ---> [B] ---> [C]  per layer-pair
		const flat: string[] = [];
		for (let li = 0; li < layers.length; li++) {
			const layer = layers[li]!;
			for (const id of layer) {
				flat.push(renderNodeBox(diag.nodes.get(id) ?? { id, label: id, shape: "bare" }));
			}
			if (li < layers.length - 1) flat.push("--->");
		}
		const oneLine = flat.join(" ");
		if (oneLine.length <= maxWidth) return oneLine;
	}

	// Multi-layer rendering with arrows between layers.
	const rendered: string[] = [];
	for (let li = 0; li < layers.length; li++) {
		const layer = layers[li]!;
		const boxes = layer.map((id) => renderNodeBox(diag.nodes.get(id) ?? { id, label: id, shape: "bare" }));
		rendered.push(boxes.join("  "));
		if (li < layers.length - 1) {
			rendered.push("   |");
			rendered.push("   v");
		}
	}

	// List remaining edges (e.g. cross-layer, back-edges) explicitly.
	const usedEdges = new Set<string>();
	for (const e of diag.edges) {
		const a = layerIndexOf(layers, e.from);
		const b = layerIndexOf(layers, e.to);
		if (a >= 0 && b === a + 1) {
			usedEdges.add(edgeKey(e));
		}
	}
	const extras: string[] = [];
	for (const e of diag.edges) {
		if (usedEdges.has(edgeKey(e))) continue;
		const arrow = e.label ? `--|${e.label}|-->` : "--->";
		const from = renderNodeBox(diag.nodes.get(e.from) ?? { id: e.from, label: e.from, shape: "bare" });
		const to = renderNodeBox(diag.nodes.get(e.to) ?? { id: e.to, label: e.to, shape: "bare" });
		extras.push(`${from} ${arrow} ${to}`);
	}
	if (extras.length > 0) {
		rendered.push("");
		rendered.push("edges:");
		for (const e of extras) rendered.push(`  ${e}`);
	}

	return rendered.join("\n");
}

function edgeKey(e: EdgeInfo): string {
	return `${e.from}${e.to}${e.label ?? ""}`;
}

function layerIndexOf(layers: string[][], id: string): number {
	for (let i = 0; i < layers.length; i++) {
		if (layers[i]!.includes(id)) return i;
	}
	return -1;
}

function renderVertical(diag: ParsedDiagram, maxWidth: number): string {
	const layers = layerNodes(diag);
	const lines: string[] = [];
	for (let li = 0; li < layers.length; li++) {
		const layer = layers[li]!;
		const boxes = layer.map((id) => renderNodeBox(diag.nodes.get(id) ?? { id, label: id, shape: "bare" }));
		const joined = boxes.join("    ");
		lines.push(joined.length <= maxWidth ? joined : boxes.join("\n"));
		if (li < layers.length - 1) {
			lines.push("   |");
			lines.push("   v");
		}
	}
	// Append non-direct edges as a list, just like horizontal mode.
	const usedEdges = new Set<string>();
	for (const e of diag.edges) {
		const a = layerIndexOf(layers, e.from);
		const b = layerIndexOf(layers, e.to);
		if (a >= 0 && b === a + 1) usedEdges.add(edgeKey(e));
	}
	const extras: string[] = [];
	for (const e of diag.edges) {
		if (usedEdges.has(edgeKey(e))) continue;
		const arrow = e.label ? `--|${e.label}|-->` : "--->";
		const from = renderNodeBox(diag.nodes.get(e.from) ?? { id: e.from, label: e.from, shape: "bare" });
		const to = renderNodeBox(diag.nodes.get(e.to) ?? { id: e.to, label: e.to, shape: "bare" });
		extras.push(`${from} ${arrow} ${to}`);
	}
	if (extras.length > 0) {
		lines.push("");
		lines.push("edges:");
		for (const e of extras) lines.push(`  ${e}`);
	}
	return lines.join("\n");
}

export function createRenderMermaidToolDefinition(
	_cwd: string,
	_options?: RenderMermaidToolOptions,
): ToolDefinition<typeof renderMermaidSchema, RenderMermaidToolDetails | undefined> {
	return {
		name: "render_mermaid",
		label: "render_mermaid",
		description:
			"Render simple Mermaid flowcharts (graph TD/LR, flowchart TD/LR) as terminal ASCII art. Complex diagrams (sequence/state/class/etc.) fall back to a fenced code block.",
		promptSnippet: "Render simple Mermaid flowcharts as ASCII.",
		promptGuidelines: [
			"Supports graph/flowchart TD or LR with node shapes [..], (..), {..} and --> / --- edges.",
			"Anything beyond simple flowcharts is returned as a fenced mermaid block — that's intentional.",
			"Keep diagrams small; very wide graphs are split across lines.",
		],
		parameters: renderMermaidSchema,
		async execute(_toolCallId, input: RenderMermaidToolInput) {
			const maxWidth = input.max_width ?? 80;
			const parsed = tryParse(input.source);
			if (!parsed) {
				return {
					content: [{ type: "text" as const, text: fallback(input.source) }],
					details: { mode: "fallback", direction: "unknown", nodeCount: 0, edgeCount: 0 },
				};
			}
			const ascii =
				parsed.direction === "LR" ? renderHorizontal(parsed, maxWidth) : renderVertical(parsed, maxWidth);
			return {
				content: [{ type: "text" as const, text: ascii }],
				details: {
					mode: "ascii",
					direction: parsed.direction,
					nodeCount: parsed.nodes.size,
					edgeCount: parsed.edges.length,
				},
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const source = str(args?.source) || "";
			const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
			const display = firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
			text.setText(`${theme.fg("toolTitle", theme.bold("render_mermaid"))} ${theme.fg("toolOutput", display)}`);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result, context.showImages).trim();
			text.setText(output ? `\n${theme.fg("toolOutput", output)}` : "");
			return text;
		},
	};
}

export function createRenderMermaidTool(
	cwd: string,
	options?: RenderMermaidToolOptions,
): AgentTool<typeof renderMermaidSchema> {
	return wrapToolDefinition(createRenderMermaidToolDefinition(cwd, options));
}
