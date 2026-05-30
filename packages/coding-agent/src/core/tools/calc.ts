/**
 * `calc` tool — deterministic arithmetic evaluator. The model passes an
 * expression, the tool computes via a sandboxed recursive-descent parser.
 * No `eval()` — no LLM in the loop.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const calcSchema = Type.Object(
	{
		expression: Type.String({
			description: 'Arithmetic expression, e.g. "2 + 3 * 4", "sin(pi/4)", "(1024*1024) / 1000".',
		}),
		precision: Type.Optional(
			Type.Number({
				description: "Decimal places for the formatted float output. Default 6.",
				minimum: 0,
				maximum: 20,
			}),
		),
	},
	{ additionalProperties: false },
);

export type CalcToolInput = Static<typeof calcSchema>;

export interface CalcToolDetails {
	value: number;
	formatted: string;
}

export interface CalcToolOptions {}

// ===== Tokenizer =====

type TokKind =
	| "num"
	| "ident"
	| "lparen"
	| "rparen"
	| "comma"
	| "plus"
	| "minus"
	| "star"
	| "slash"
	| "percent"
	| "caret"
	| "eof";

interface Tok {
	kind: TokKind;
	value: string;
	pos: number;
}

function tokenize(input: string): Tok[] {
	const out: Tok[] = [];
	let i = 0;
	const len = input.length;
	while (i < len) {
		const c = input[i]!;
		if (c === " " || c === "\t" || c === "\n" || c === "\r") {
			i++;
			continue;
		}
		if ((c >= "0" && c <= "9") || (c === "." && input[i + 1] && input[i + 1]! >= "0" && input[i + 1]! <= "9")) {
			const start = i;
			while (i < len && input[i]! >= "0" && input[i]! <= "9") i++;
			if (input[i] === ".") {
				i++;
				while (i < len && input[i]! >= "0" && input[i]! <= "9") i++;
			}
			if (input[i] === "e" || input[i] === "E") {
				i++;
				if (input[i] === "+" || input[i] === "-") i++;
				while (i < len && input[i]! >= "0" && input[i]! <= "9") i++;
			}
			out.push({ kind: "num", value: input.slice(start, i), pos: start });
			continue;
		}
		if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") {
			const start = i;
			while (
				i < len &&
				((input[i]! >= "a" && input[i]! <= "z") ||
					(input[i]! >= "A" && input[i]! <= "Z") ||
					(input[i]! >= "0" && input[i]! <= "9") ||
					input[i] === "_")
			) {
				i++;
			}
			out.push({ kind: "ident", value: input.slice(start, i), pos: start });
			continue;
		}
		switch (c) {
			case "(":
				out.push({ kind: "lparen", value: "(", pos: i });
				i++;
				continue;
			case ")":
				out.push({ kind: "rparen", value: ")", pos: i });
				i++;
				continue;
			case ",":
				out.push({ kind: "comma", value: ",", pos: i });
				i++;
				continue;
			case "+":
				out.push({ kind: "plus", value: "+", pos: i });
				i++;
				continue;
			case "-":
				out.push({ kind: "minus", value: "-", pos: i });
				i++;
				continue;
			case "*":
				if (input[i + 1] === "*") {
					out.push({ kind: "caret", value: "**", pos: i });
					i += 2;
				} else {
					out.push({ kind: "star", value: "*", pos: i });
					i++;
				}
				continue;
			case "/":
				out.push({ kind: "slash", value: "/", pos: i });
				i++;
				continue;
			case "%":
				out.push({ kind: "percent", value: "%", pos: i });
				i++;
				continue;
			case "^":
				out.push({ kind: "caret", value: "^", pos: i });
				i++;
				continue;
			default:
				throw new CalcError(`Unsupported in calc: ${c}. Use Python via eval for complex expressions.`);
		}
	}
	out.push({ kind: "eof", value: "", pos: i });
	return out;
}

class CalcError extends Error {}

// ===== Constants and functions =====

const CONSTS: Record<string, number> = {
	pi: Math.PI,
	e: Math.E,
};

type Fn = (args: number[]) => number;

const FUNCS: Record<string, { arity: number | [number, number]; fn: Fn }> = {
	abs: { arity: 1, fn: ([a]) => Math.abs(a!) },
	sqrt: { arity: 1, fn: ([a]) => Math.sqrt(a!) },
	exp: { arity: 1, fn: ([a]) => Math.exp(a!) },
	log: {
		arity: [1, 2],
		fn: (args) => (args.length === 2 ? Math.log(args[0]!) / Math.log(args[1]!) : Math.log(args[0]!)),
	},
	log2: { arity: 1, fn: ([a]) => Math.log2(a!) },
	log10: { arity: 1, fn: ([a]) => Math.log10(a!) },
	sin: { arity: 1, fn: ([a]) => Math.sin(a!) },
	cos: { arity: 1, fn: ([a]) => Math.cos(a!) },
	tan: { arity: 1, fn: ([a]) => Math.tan(a!) },
	asin: { arity: 1, fn: ([a]) => Math.asin(a!) },
	acos: { arity: 1, fn: ([a]) => Math.acos(a!) },
	atan: { arity: [1, 2], fn: (args) => (args.length === 2 ? Math.atan2(args[0]!, args[1]!) : Math.atan(args[0]!)) },
	floor: { arity: 1, fn: ([a]) => Math.floor(a!) },
	ceil: { arity: 1, fn: ([a]) => Math.ceil(a!) },
	round: { arity: 1, fn: ([a]) => Math.round(a!) },
	min: { arity: [1, 16], fn: (args) => Math.min(...args) },
	max: { arity: [1, 16], fn: (args) => Math.max(...args) },
	pow: { arity: 2, fn: ([a, b]) => a! ** b! },
	mod: { arity: 2, fn: ([a, b]) => a! % b! },
};

// ===== Recursive-descent parser =====

class Parser {
	private pos = 0;
	private readonly toks: Tok[];
	constructor(toks: Tok[]) {
		this.toks = toks;
	}
	private peek(): Tok {
		return this.toks[this.pos]!;
	}
	private eat(): Tok {
		return this.toks[this.pos++]!;
	}
	private expect(kind: TokKind): Tok {
		const t = this.peek();
		if (t.kind !== kind) {
			throw new CalcError(`Expected ${kind} but got '${t.value || t.kind}' at position ${t.pos}.`);
		}
		return this.eat();
	}

	parse(): number {
		const v = this.expr();
		if (this.peek().kind !== "eof") {
			const t = this.peek();
			throw new CalcError(`Unexpected '${t.value || t.kind}' at position ${t.pos}.`);
		}
		return v;
	}

	// expr := term ( (+|-) term )*
	private expr(): number {
		let left = this.term();
		while (this.peek().kind === "plus" || this.peek().kind === "minus") {
			const op = this.eat().kind;
			const right = this.term();
			left = op === "plus" ? left + right : left - right;
		}
		return left;
	}

	// term := factor ( (*|/|%) factor )*
	private term(): number {
		let left = this.factor();
		while (this.peek().kind === "star" || this.peek().kind === "slash" || this.peek().kind === "percent") {
			const op = this.eat().kind;
			const right = this.factor();
			if (op === "star") left = left * right;
			else if (op === "slash") left = left / right;
			else left = left % right;
		}
		return left;
	}

	// factor := unary ( ^ factor )?    (right-assoc)
	private factor(): number {
		const base = this.unary();
		if (this.peek().kind === "caret") {
			this.eat();
			const exp = this.factor();
			return base ** exp;
		}
		return base;
	}

	// unary := (+|-) unary | primary
	private unary(): number {
		if (this.peek().kind === "plus") {
			this.eat();
			return this.unary();
		}
		if (this.peek().kind === "minus") {
			this.eat();
			return -this.unary();
		}
		return this.primary();
	}

	// primary := num | ident ( ( args? ) )? | ( expr )
	private primary(): number {
		const t = this.peek();
		if (t.kind === "num") {
			this.eat();
			const n = Number(t.value);
			if (!Number.isFinite(n)) throw new CalcError(`Invalid number '${t.value}'.`);
			return n;
		}
		if (t.kind === "lparen") {
			this.eat();
			const v = this.expr();
			this.expect("rparen");
			return v;
		}
		if (t.kind === "ident") {
			this.eat();
			const name = t.value.toLowerCase();
			// Function call?
			if (this.peek().kind === "lparen") {
				this.eat();
				const args: number[] = [];
				if (this.peek().kind !== "rparen") {
					args.push(this.expr());
					while (this.peek().kind === "comma") {
						this.eat();
						args.push(this.expr());
					}
				}
				this.expect("rparen");
				const fn = FUNCS[name];
				if (!fn) {
					throw new CalcError(`Unsupported in calc: ${t.value}. Use Python via eval for complex expressions.`);
				}
				const a = fn.arity;
				if (typeof a === "number") {
					if (args.length !== a) {
						throw new CalcError(`Function '${name}' expects ${a} argument(s), got ${args.length}.`);
					}
				} else {
					if (args.length < a[0] || args.length > a[1]) {
						throw new CalcError(`Function '${name}' expects ${a[0]}..${a[1]} arguments, got ${args.length}.`);
					}
				}
				return fn.fn(args);
			}
			// Constant
			if (name in CONSTS) return CONSTS[name]!;
			throw new CalcError(`Unsupported in calc: ${t.value}. Use Python via eval for complex expressions.`);
		}
		throw new CalcError(`Unexpected '${t.value || t.kind}' at position ${t.pos}.`);
	}
}

function evaluate(expression: string): number {
	const toks = tokenize(expression);
	if (toks.length === 1 && toks[0]!.kind === "eof") {
		throw new CalcError("Empty expression.");
	}
	const parser = new Parser(toks);
	return parser.parse();
}

function formatValue(value: number, precision: number): string {
	if (!Number.isFinite(value)) {
		if (Number.isNaN(value)) return "NaN";
		return value > 0 ? "Infinity" : "-Infinity";
	}
	if (Number.isInteger(value)) {
		return String(value);
	}
	const fixed = value.toFixed(precision);
	// Trim trailing zeros, but keep at least one decimal place when it had a fractional part.
	const trimmed = fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
	return trimmed;
}

export function createCalcToolDefinition(
	_cwd: string,
	_options?: CalcToolOptions,
): ToolDefinition<typeof calcSchema, CalcToolDetails> {
	return {
		name: "calc",
		label: "calc",
		description:
			"Deterministic arithmetic evaluator. Supports + - * / % ^, parentheses, unary minus, the constants pi/e, and functions abs, sqrt, exp, log, log2, log10, sin, cos, tan, asin, acos, atan, floor, ceil, round, min, max, pow, mod. No variables, no statements.",
		promptSnippet: "Compute an arithmetic expression deterministically.",
		promptGuidelines: [
			"Use calc for arithmetic — never bash echo $((...)) or python -c for math.",
			"Supports constants pi, e and functions like sin, log, sqrt, pow, min, max.",
			"For anything beyond arithmetic (variables, control flow, libraries) use eval instead.",
		],
		parameters: calcSchema,
		async execute(_toolCallId, input: CalcToolInput) {
			const precision = input.precision ?? 6;
			try {
				const value = evaluate(input.expression);
				const formatted = formatValue(value, precision);
				return {
					content: [{ type: "text" as const, text: formatted }],
					details: { value, formatted },
				};
			} catch (err) {
				const msg = err instanceof CalcError ? err.message : ((err as Error).message ?? String(err));
				return {
					content: [{ type: "text" as const, text: `calc error: ${msg}` }],
					isError: true,
					details: { value: Number.NaN, formatted: "NaN" },
				};
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const expr = str(args?.expression) || "";
			const display = expr.length > 70 ? `${expr.slice(0, 69)}…` : expr;
			text.setText(`${theme.fg("toolTitle", theme.bold("calc"))} ${theme.fg("toolOutput", display)}`);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result as any, context.showImages).trim();
			text.setText(output ? ` = ${theme.fg("accent", output)}` : "");
			return text;
		},
	};
}

export function createCalcTool(cwd: string, options?: CalcToolOptions): AgentTool<typeof calcSchema> {
	return wrapToolDefinition(createCalcToolDefinition(cwd, options));
}
