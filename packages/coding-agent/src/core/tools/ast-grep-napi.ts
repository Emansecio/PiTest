import type { AstGrepMatch } from "./ast-grep.ts";

/**
 * Optional in-process `@ast-grep/napi` backend for the ast_grep tool.
 *
 * The same Rust ast-grep engine as the CLI, but run in-process via N-API —
 * removing the per-query process spawn + NDJSON serialization. Measured ~2x on
 * scoped searches and parity-identical (same file:line:col) to the CLI on its
 * supported subset. Unlike fff there is NO warm index: each call reparses the
 * files, so the win is the spawn overhead, not caching.
 *
 * The bigger payoff is ZERO-CONFIG: the CLI must be on PATH (the tool is broken
 * without it), whereas this package ships prebuilt platform binaries as an
 * optionalDependency. The tool falls back to the CLI for everything this backend
 * can't serve (no/unsupported lang, globs, context) or when the package is
 * absent — so the CLI path is never removed, only bypassed when possible.
 *
 * Lazy-loaded via `await import()` (ESM-friendly, mirrors fff-search.ts); any
 * load failure marks the backend unavailable so a platform without the native
 * binary degrades to the CLI instead of crashing.
 */

// ---- Minimal structural types for the optional package (avoid a hard type
// dependency so tsgo/builds succeed on machines where the dep is absent). ----
interface SgRange {
	start: { line: number; column: number };
	end: { line: number; column: number };
}
interface SgNode {
	range: () => SgRange;
	text: () => string;
	getRoot: () => SgRoot;
}
interface SgRoot {
	filename: () => string;
	root: () => { text: () => string };
}
interface NapiModule {
	Lang: Record<string, unknown>;
	findInFiles: (
		lang: unknown,
		config: { paths: string[]; matcher: { rule: { pattern: string } } },
		callback: (err: null | Error, nodes: SgNode[]) => void,
	) => Promise<number>;
}

/** User lang id → key into the napi `Lang` enum. Only built-in napi languages;
 * jsx/py/rs/go/… are not bundled (need dynamic language packs) → CLI fallback. */
const LANG_KEY: Record<string, string> = {
	ts: "TypeScript",
	typescript: "TypeScript",
	tsx: "Tsx",
	js: "JavaScript",
	javascript: "JavaScript",
	mjs: "JavaScript",
	cjs: "JavaScript",
	html: "Html",
	css: "Css",
};

let moduleState: { mod: NapiModule } | "unavailable" | "unloaded" = "unloaded";
let loadPromise: Promise<NapiModule | null> | null = null;

function loadModule(): Promise<NapiModule | null> {
	if (moduleState === "unavailable") return Promise.resolve(null);
	if (moduleState !== "unloaded") return Promise.resolve(moduleState.mod);
	if (!loadPromise) {
		loadPromise = (async () => {
			try {
				const mod = (await import("@ast-grep/napi")) as unknown as NapiModule;
				if (!mod || typeof mod.findInFiles !== "function" || !mod.Lang) {
					moduleState = "unavailable";
					return null;
				}
				moduleState = { mod };
				return mod;
			} catch {
				moduleState = "unavailable";
				return null;
			}
		})();
	}
	return loadPromise;
}

/** Whether the napi backend can be loaded on this machine. */
export async function isAstGrepNapiAvailable(): Promise<boolean> {
	return (await loadModule()) !== null;
}

/** Whether a user-supplied lang id maps to a built-in napi language. */
export function isNapiSupportedLang(lang: string | undefined): boolean {
	return lang !== undefined && LANG_KEY[lang.toLowerCase()] !== undefined;
}

export interface AstGrepNapiSearchArgs {
	pattern: string;
	lang: string;
	target: string;
}

/**
 * Run a structural search through the in-process napi engine. Returns matches in
 * the SAME shape the CLI's --json=stream path produces (file/range/text/lines)
 * so the tool formats them identically, or null on ANY failure / unsupported
 * condition so the caller transparently falls back to the ast-grep CLI — this
 * backend never throws. Results are not limit-capped here; the caller caps and
 * formats exactly as it does for CLI output.
 */
export async function astGrepNapiSearch(args: AstGrepNapiSearchArgs): Promise<AstGrepMatch[] | null> {
	const langKey = LANG_KEY[args.lang.toLowerCase()];
	if (!langKey) return null;
	const mod = await loadModule();
	if (!mod) return null;
	const langValue = mod.Lang[langKey];
	if (langValue === undefined) return null;
	try {
		const matches: AstGrepMatch[] = [];
		const srcCache = new Map<string, string[]>();
		await mod.findInFiles(
			langValue,
			{ paths: [args.target], matcher: { rule: { pattern: args.pattern } } },
			(err, nodes) => {
				if (err || !nodes) return;
				for (const n of nodes) {
					try {
						const root = n.getRoot();
						const file = root.filename();
						let srcLines = srcCache.get(file);
						if (!srcLines) {
							srcLines = root.root().text().split(/\r?\n/);
							srcCache.set(file, srcLines);
						}
						const r = n.range();
						// Reconstruct the CLI's `lines` field (physical source lines spanned
						// by the match) so formatting is identical to the CLI path.
						const lines = srcLines.slice(r.start.line, r.end.line + 1).join("\n");
						matches.push({
							file,
							range: {
								start: { line: r.start.line, column: r.start.column },
								end: { line: r.end.line, column: r.end.column },
							},
							text: n.text(),
							lines,
						});
					} catch {
						// Skip a node we can't read rather than failing the whole search.
					}
				}
			},
		);
		return matches;
	} catch {
		// Invalid pattern, unreadable path, native error → defer to the CLI, which
		// surfaces the real diagnostic (e.g. a pattern parse error).
		return null;
	}
}
