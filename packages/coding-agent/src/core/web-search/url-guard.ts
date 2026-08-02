/**
 * SSRF guard for outbound URL fetches (`web_fetch`, and any future tool that
 * dereferences a model-supplied URL).
 *
 * The threat: the model (or a page it just read) hands us a URL that points at
 * something only *we* can reach — the loopback interface, an RFC1918 LAN host,
 * or the cloud metadata endpoint at 169.254.169.254 — and we happily fetch it
 * and paste the contents into the transcript.
 *
 * The guard is deliberately fail-closed:
 *  - only `http:` / `https:` survive; every other scheme (file:, gopher:,
 *    data:, ftp:) is rejected outright;
 *  - `user:pass@host` credentials are rejected (they are an exfil vector and a
 *    classic parser-confusion trick);
 *  - the hostname is resolved (A **and** AAAA) and **every** returned address
 *    must be public — one private answer rejects the whole URL, which is what
 *    kills DNS-rebinding-style setups that publish both a public and a private
 *    record;
 *  - a literal IP host skips DNS but goes through the exact same address
 *    classification, including IPv4-in-IPv6 (`::ffff:10.0.0.1`) and NAT64
 *    (`64:ff9b::/96`) forms that would otherwise smuggle a private v4 address
 *    past a naive v6 check.
 *
 * DNS failure is *also* a rejection: we cannot prove the target is public, so
 * we do not fetch it.
 *
 * Known limitation (accepted v1): the guard resolves DNS and then the fetch
 * resolves AGAIN — a TTL-0 rebinding server could answer public here and
 * private there. Closing it needs address pinning (custom dispatcher/lookup on
 * the fetch); the mixed-answer rejection above narrows but does not eliminate
 * the window. Revisit if web_fetch ever runs in an environment with reachable
 * internal services.
 *
 * The WHATWG `URL` parser does the numeric-host normalization for us —
 * `http://2130706433/` and `http://0x7f.1/` both arrive here as `127.0.0.1` —
 * so this module only has to classify canonical dotted-quad / hextet forms.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Resolves a hostname to the list of IP addresses it maps to (A + AAAA). */
export type DnsResolver = (hostname: string) => Promise<string[]>;

export interface UrlGuardOptions {
	/** Override the DNS resolver (tests inject a stub; hermetic suite does no real DNS). */
	resolve?: DnsResolver;
}

export interface UrlCheckResult {
	allowed: boolean;
	/** Human-readable rejection reason; only set when `allowed` is false. */
	reason?: string;
	/** Parsed + normalized URL; only set when parsing succeeded. */
	url?: URL;
	/** Addresses the hostname resolved to (a single entry for literal-IP hosts). */
	addresses?: string[];
}

/** Thrown by {@link assertUrlAllowed}. Callers treat this as terminal — never a fallback trigger. */
export class UrlBlockedError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "UrlBlockedError";
	}
}

// ===== IPv4 =====

/** Parse a canonical dotted-quad into 4 octets, or undefined when malformed. */
function parseIpv4(text: string): number[] | undefined {
	const parts = text.split(".");
	if (parts.length !== 4) return undefined;
	const out: number[] = [];
	for (const part of parts) {
		if (part.length === 0 || part.length > 3 || !/^\d+$/.test(part)) return undefined;
		const n = Number(part);
		if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
		out.push(n);
	}
	return out;
}

/**
 * Classify an IPv4 address. Returns a rejection reason, or undefined when the
 * address is a routable public one.
 *
 * Beyond the ranges the spec names (loopback, RFC1918, link-local) this also
 * rejects the "special-purpose" blocks that are equally non-public and equally
 * useful to an attacker: CGNAT (100.64/10), IETF protocol assignments
 * (192.0.0/24), benchmarking (198.18/15), multicast (224/4) and reserved
 * (240/4, which includes the 255.255.255.255 broadcast address).
 */
function classifyIpv4(octets: number[]): string | undefined {
	const [a, b] = octets as [number, number, number, number];
	if (a === 0) return "0.0.0.0/8 (this-network)";
	if (a === 10) return "10.0.0.0/8 (private)";
	if (a === 127) return "127.0.0.0/8 (loopback)";
	if (a === 100 && b >= 64 && b <= 127) return "100.64.0.0/10 (carrier-grade NAT)";
	if (a === 169 && b === 254) return "169.254.0.0/16 (link-local / cloud metadata)";
	if (a === 172 && b >= 16 && b <= 31) return "172.16.0.0/12 (private)";
	if (a === 192 && b === 0 && octets[2] === 0) return "192.0.0.0/24 (IETF protocol assignments)";
	if (a === 192 && b === 168) return "192.168.0.0/16 (private)";
	if (a === 198 && (b === 18 || b === 19)) return "198.18.0.0/15 (benchmarking)";
	if (a >= 224 && a <= 239) return "224.0.0.0/4 (multicast)";
	if (a >= 240) return "240.0.0.0/4 (reserved)";
	return undefined;
}

// ===== IPv6 =====

/**
 * Expand an IPv6 literal into its 8 hextets. Handles `::` compression, a zone
 * id suffix (`%eth0`), and a trailing embedded IPv4 (`::ffff:10.0.0.1`) which
 * is rewritten into two hextets before the standard expansion runs.
 */
function parseIpv6(text: string): number[] | undefined {
	let s = text.replace(/%.*$/, "");
	if (s.includes(".")) {
		const colon = s.lastIndexOf(":");
		if (colon < 0) return undefined;
		const v4 = parseIpv4(s.slice(colon + 1));
		if (!v4) return undefined;
		const hi = ((v4[0] as number) << 8) | (v4[1] as number);
		const lo = ((v4[2] as number) << 8) | (v4[3] as number);
		s = `${s.slice(0, colon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
	}
	const halves = s.split("::");
	if (halves.length > 2) return undefined;
	const toHextets = (chunk: string): number[] | undefined => {
		if (chunk.length === 0) return [];
		const out: number[] = [];
		for (const piece of chunk.split(":")) {
			if (piece.length === 0 || piece.length > 4 || !/^[0-9a-fA-F]+$/.test(piece)) return undefined;
			out.push(Number.parseInt(piece, 16));
		}
		return out;
	};
	const head = toHextets(halves[0] as string);
	if (!head) return undefined;
	if (halves.length === 1) return head.length === 8 ? head : undefined;
	const tail = toHextets(halves[1] as string);
	if (!tail) return undefined;
	const fill = 8 - head.length - tail.length;
	if (fill < 1) return undefined;
	return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** Classify an IPv6 address, delegating v4-mapped/compatible/NAT64 forms to the v4 rules. */
function classifyIpv6(h: number[]): string | undefined {
	const zeroHead = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;
	// ::ffff:a.b.c.d (v4-mapped), ::a.b.c.d (deprecated v4-compatible), and
	// 64:ff9b::a.b.c.d (NAT64) all carry a v4 address in the last two hextets.
	const embedded =
		(zeroHead && h[5] === 0xffff) ||
		(zeroHead && h[5] === 0 && (h[6] !== 0 || h[7] !== 0)) ||
		(h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0);
	if (embedded) {
		const hi = h[6] as number;
		const lo = h[7] as number;
		const v4 = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
		// ::1 falls into the "v4-compatible" shape; name it as loopback instead.
		if (zeroHead && h[5] === 0 && hi === 0 && lo === 1) return "::1 (loopback)";
		return classifyIpv4(v4);
	}
	if (h.every((x) => x === 0)) return ":: (unspecified)";
	if (((h[0] as number) & 0xfe00) === 0xfc00) return "fc00::/7 (unique local)";
	if (((h[0] as number) & 0xffc0) === 0xfe80) return "fe80::/10 (link-local)";
	if ((h[0] as number) >> 8 === 0xff) return "ff00::/8 (multicast)";
	return undefined;
}

/**
 * Classify a literal IP address. Returns a rejection reason string when the
 * address is not publicly routable, or undefined when it is fine to fetch.
 * An unparseable address is rejected (fail-closed).
 *
 * Exported for tests and for callers that already hold a resolved address.
 */
export function classifyIpAddress(ip: string): string | undefined {
	const family = isIP(ip);
	if (family === 4) {
		const octets = parseIpv4(ip);
		return octets ? classifyIpv4(octets) : "unparseable IPv4 address";
	}
	if (family === 6) {
		const hextets = parseIpv6(ip);
		return hextets ? classifyIpv6(hextets) : "unparseable IPv6 address";
	}
	// node's isIP rejects zone ids on some versions; retry the v6 parser directly.
	const hextets = parseIpv6(ip);
	if (hextets) return classifyIpv6(hextets);
	return "not an IP address";
}

async function defaultResolve(hostname: string): Promise<string[]> {
	// `all: true` with the default family 0 returns both A and AAAA records, and
	// honors the OS hosts file — which matters, because `localhost` (and any
	// hosts-file alias for an internal box) must be caught here too.
	const entries = await lookup(hostname, { all: true, verbatim: true });
	return entries.map((e) => e.address);
}

/**
 * Validate a URL for outbound fetching. Never throws for a rejected URL —
 * returns `{ allowed: false, reason }` so callers can surface the reason.
 */
export async function checkUrlAllowed(raw: string | URL, options: UrlGuardOptions = {}): Promise<UrlCheckResult> {
	let url: URL;
	try {
		url = raw instanceof URL ? raw : new URL(raw);
	} catch {
		return { allowed: false, reason: `not a valid absolute URL: ${String(raw)}` };
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { allowed: false, reason: `unsupported scheme "${url.protocol}" (only http/https)`, url };
	}
	if (url.username !== "" || url.password !== "") {
		return { allowed: false, reason: "URL carries embedded credentials (user:pass@) — refusing to fetch", url };
	}

	// `url.hostname` keeps the brackets on an IPv6 literal.
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (host.length === 0) {
		return { allowed: false, reason: "URL has no host", url };
	}

	let addresses: string[];
	if (isIP(host) !== 0) {
		addresses = [host];
	} else {
		const resolve = options.resolve ?? defaultResolve;
		try {
			addresses = await resolve(host);
		} catch (err) {
			return { allowed: false, reason: `DNS resolution failed for "${host}": ${(err as Error).message}`, url };
		}
		if (addresses.length === 0) {
			return { allowed: false, reason: `DNS returned no addresses for "${host}"`, url };
		}
	}

	for (const address of addresses) {
		const blocked = classifyIpAddress(address);
		if (blocked) {
			return {
				allowed: false,
				reason: `"${host}" resolves to ${address}, which is in ${blocked} — refusing to fetch a non-public address`,
				url,
				addresses,
			};
		}
	}

	return { allowed: true, url, addresses };
}

/** {@link checkUrlAllowed} that throws {@link UrlBlockedError} instead of returning a result. */
export async function assertUrlAllowed(raw: string | URL, options: UrlGuardOptions = {}): Promise<URL> {
	const result = await checkUrlAllowed(raw, options);
	if (!result.allowed || !result.url) {
		throw new UrlBlockedError(result.reason ?? "URL rejected");
	}
	return result.url;
}
