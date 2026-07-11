/**
 * Sync lazy-load for optional local modules (chrome / lsp / debug).
 *
 * Prefer Node `createRequire` (`.js` in dist, `.ts` under tsx). Fall back to a
 * shared jiti instance when vitest's require cannot resolve the TypeScript
 * import graph — one jiti cache so singletons (e.g. chrome manager registry)
 * stay consistent across callers.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const sharedJiti = createJiti(import.meta.url);

export function requireOptional<T>(fromImportMetaUrl: string, specifierTs: string): T {
	const requireOpt = createRequire(fromImportMetaUrl);
	const specifierJs = specifierTs.replace(/\.ts$/, ".js");
	for (const id of [specifierJs, specifierTs]) {
		try {
			return requireOpt(id) as T;
		} catch {
			// try next candidate / jiti
		}
	}
	const absolute = fileURLToPath(new URL(specifierTs, fromImportMetaUrl));
	return sharedJiti(absolute) as T;
}
