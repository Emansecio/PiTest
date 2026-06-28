/** Shared `appliesTo` matching for tool rewrite and error-hint rule registries. */
export function ruleAppliesTo(rule: { appliesTo: string | string[] | "*" }, toolName: string): boolean {
	if (rule.appliesTo === "*") return true;
	if (typeof rule.appliesTo === "string") return rule.appliesTo === toolName;
	return rule.appliesTo.includes(toolName);
}
