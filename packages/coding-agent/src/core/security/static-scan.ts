import { createHash } from "node:crypto";
import { astGrepNapiSearch } from "../tools/ast-grep-napi.ts";

export type SecurityRulePackName = "javascript-core";

interface SecurityAstRule {
	id: string;
	pattern: string;
	severity: "low" | "medium" | "high";
	message: string;
}

const RULE_PACKS: Record<SecurityRulePackName, readonly SecurityAstRule[]> = {
	"javascript-core": [
		{
			id: "js.dynamic-eval",
			pattern: "eval($EXPR)",
			severity: "high",
			message: "Dynamic code evaluation receives a non-literal expression",
		},
		{
			id: "js.dynamic-query",
			pattern: "$DB.query($QUERY)",
			severity: "medium",
			message: "Database query sink requires data-flow review",
		},
		{
			id: "js.html-assignment",
			pattern: "$NODE.innerHTML = $VALUE",
			severity: "medium",
			message: "HTML assignment sink requires encoding/data-flow review",
		},
	],
};

export interface StaticSecurityFinding {
	id: string;
	state: "candidate";
	ruleId: string;
	severity: SecurityAstRule["severity"];
	message: string;
	file: string;
	line: number;
	column: number;
	text: string;
}

export interface SecurityStaticScanInput {
	path: string;
	language: "ts" | "tsx" | "js";
	pack?: SecurityRulePackName;
	limit?: number;
}

export interface SecurityStaticScanResult {
	engine: "ast_grep";
	pack: SecurityRulePackName;
	findings: StaticSecurityFinding[];
	truncated: boolean;
}

export async function scanSecurityStatic(input: SecurityStaticScanInput): Promise<SecurityStaticScanResult> {
	const pack = input.pack ?? "javascript-core";
	const limit = Math.max(1, Math.min(500, input.limit ?? 100));
	const findings: StaticSecurityFinding[] = [];
	for (const rule of RULE_PACKS[pack]) {
		const matches = await astGrepNapiSearch({ pattern: rule.pattern, lang: input.language, target: input.path });
		if (matches === null) throw new Error("The existing ast_grep N-API engine is unavailable for this scan");
		for (const match of matches) {
			const line = (match.range?.start?.line ?? 0) + 1;
			const column = (match.range?.start?.column ?? 0) + 1;
			const file = match.file ?? "<unknown>";
			const text = match.text ?? match.lines ?? "";
			const id = createHash("sha256")
				.update(`${rule.id}\0${file}\0${line}\0${column}\0${text}`)
				.digest("hex")
				.slice(0, 20);
			findings.push({
				id,
				state: "candidate",
				ruleId: rule.id,
				severity: rule.severity,
				message: rule.message,
				file,
				line,
				column,
				text,
			});
		}
	}
	findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.ruleId.localeCompare(b.ruleId));
	return { engine: "ast_grep", pack, findings: findings.slice(0, limit), truncated: findings.length > limit };
}
