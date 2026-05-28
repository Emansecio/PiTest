/**
 * URL scheme registry for the read/write tools.
 *
 * A scheme resolver maps a URL like `pr://1428/diff/1` or `conflict://1` to
 * text content, a directory-like listing, or a structured error. Resolvers are
 * registered once at session boot and looked up by scheme name.
 */

export interface UrlReadResult {
	kind: "text" | "directory" | "error";
	content?: string;
	entries?: Array<{ name: string; isDir: boolean }>;
	error?: string;
	mimeType?: string;
}

export interface UrlContext {
	cwd: string;
	signal?: AbortSignal;
}

export interface UrlSchemeResolver {
	scheme: string;
	read(url: URL, ctx: UrlContext): Promise<UrlReadResult>;
	canWrite?: (url: URL) => boolean;
	write?: (url: URL, content: string, ctx: UrlContext) => Promise<void>;
}

export interface UrlSchemeRegistry {
	register(resolver: UrlSchemeResolver): void;
	get(scheme: string): UrlSchemeResolver | undefined;
	list(): string[];
	parse(path: string): { url: URL; resolver: UrlSchemeResolver } | undefined;
}

// Matches a URL-like prefix: lowercase scheme followed by `://`.
const URL_SCHEME_RE = /^([a-z][a-z0-9+-]*):\/\//;

export function isUrlSchemePath(path: string): boolean {
	return URL_SCHEME_RE.test(path);
}

class UrlSchemeRegistryImpl implements UrlSchemeRegistry {
	private readonly resolvers = new Map<string, UrlSchemeResolver>();

	register(resolver: UrlSchemeResolver): void {
		// Idempotent: ignore re-registration so the session boot path can call
		// `registerBuiltinSchemes()` safely on every cold-start.
		if (this.resolvers.has(resolver.scheme)) return;
		this.resolvers.set(resolver.scheme, resolver);
	}

	get(scheme: string): UrlSchemeResolver | undefined {
		return this.resolvers.get(scheme);
	}

	list(): string[] {
		return Array.from(this.resolvers.keys());
	}

	parse(path: string): { url: URL; resolver: UrlSchemeResolver } | undefined {
		const m = URL_SCHEME_RE.exec(path);
		if (!m) return undefined;
		const scheme = m[1];
		const resolver = this.resolvers.get(scheme);
		if (!resolver) return undefined;
		let url: URL;
		try {
			url = new URL(path);
		} catch {
			return undefined;
		}
		return { url, resolver };
	}
}

let singleton: UrlSchemeRegistry | undefined;

export function getUrlSchemeRegistry(): UrlSchemeRegistry {
	if (!singleton) singleton = new UrlSchemeRegistryImpl();
	return singleton;
}
