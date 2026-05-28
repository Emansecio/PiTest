export * from "./conflict.ts";
export * from "./issue.ts";
export * from "./pr.ts";
export * from "./registry.ts";

import { createConflictSchemeResolver } from "./conflict.ts";
import { createIssueSchemeResolver } from "./issue.ts";
import { createPrSchemeResolver } from "./pr.ts";
import { getUrlSchemeRegistry } from "./registry.ts";

export function registerBuiltinSchemes(): void {
	const r = getUrlSchemeRegistry();
	r.register(createPrSchemeResolver());
	r.register(createIssueSchemeResolver());
	r.register(createConflictSchemeResolver());
}
