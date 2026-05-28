/**
 * Site-aware markdown extractors used by the `web_search` tool when the
 * caller asks for `extract: true`. Each extractor detects its host pattern
 * and either hits a structured registry API (npm/PyPI/crates.io) or scrapes
 * the rendered HTML with regex-based helpers. Output is capped at 4KB.
 */

const MAX_BYTES = 4096;
const FETCH_TIMEOUT_MS = 10_000;

export interface ExtractedContent {
	markdown: string;
	host: string;
	source: "github" | "arxiv" | "stackoverflow" | "mdn" | "docs.rs" | "npm" | "pypi" | "crates.io" | "generic";
}

function cap(text: string, max: number = MAX_BYTES): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3)}...`;
}

function decodeEntities(text: string): string {
	return text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

export function stripBoilerplate(html: string): string {
	let out = html;
	out = out.replace(/<!--[\s\S]*?-->/g, "");
	out = out.replace(/<script\b[\s\S]*?<\/script>/gi, "");
	out = out.replace(/<style\b[\s\S]*?<\/style>/gi, "");
	out = out.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");
	out = out.replace(/<svg\b[\s\S]*?<\/svg>/gi, "");
	out = out.replace(/<nav\b[\s\S]*?<\/nav>/gi, "");
	out = out.replace(/<header\b[\s\S]*?<\/header>/gi, "");
	out = out.replace(/<footer\b[\s\S]*?<\/footer>/gi, "");
	out = out.replace(/<aside\b[\s\S]*?<\/aside>/gi, "");
	out = out.replace(/<form\b[\s\S]*?<\/form>/gi, "");
	return out;
}

export function htmlToMarkdown(html: string): string {
	let out = stripBoilerplate(html);
	// Headings
	out = out.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => `\n# ${stripTags(c)}\n`);
	out = out.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => `\n## ${stripTags(c)}\n`);
	out = out.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => `\n### ${stripTags(c)}\n`);
	out = out.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, (_, c) => `\n#### ${stripTags(c)}\n`);
	out = out.replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, (_, c) => `\n##### ${stripTags(c)}\n`);
	out = out.replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, (_, c) => `\n###### ${stripTags(c)}\n`);
	// Code blocks
	out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => `\n\`\`\`\n${stripTags(c)}\n\`\`\`\n`);
	out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => `\`${stripTags(c)}\``);
	// Links
	out = out.replace(
		/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
		(_, href, c) => `[${stripTags(c)}](${href})`,
	);
	// Lists
	out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `- ${stripTags(c)}\n`);
	// Paragraphs and breaks
	out = out.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, c) => `\n${stripTags(c)}\n`);
	out = out.replace(/<br\s*\/?\s*>/gi, "\n");
	// Strip remaining tags
	out = stripTags(out);
	out = decodeEntities(out);
	out = out.replace(/\n{3,}/g, "\n\n").trim();
	return out;
}

function stripTags(html: string): string {
	return html.replace(/<[^>]+>/g, "");
}

function combineSignals(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new Error("extract timeout")), timeoutMs);
	const onAbort = () => ctrl.abort((signal as AbortSignal).reason);
	if (signal) {
		if (signal.aborted) ctrl.abort(signal.reason);
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: ctrl.signal,
		cancel: () => {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
		},
	};
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
	const { signal: combined, cancel } = combineSignals(FETCH_TIMEOUT_MS, signal);
	try {
		const res = await fetch(url, {
			signal: combined,
			headers: {
				"User-Agent": "pi-coding-agent/1.0 (+web_search)",
				Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
			},
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText}`);
		}
		return await res.text();
	} finally {
		cancel();
	}
}

async function fetchJsonRaw(url: string, signal?: AbortSignal): Promise<unknown> {
	const { signal: combined, cancel } = combineSignals(FETCH_TIMEOUT_MS, signal);
	try {
		const res = await fetch(url, {
			signal: combined,
			headers: {
				"User-Agent": "pi-coding-agent/1.0 (+web_search)",
				Accept: "application/json",
			},
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
		return (await res.json()) as unknown;
	} finally {
		cancel();
	}
}

function parseHost(url: string): string {
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return "";
	}
}

async function extractGitHub(url: string, host: string, signal?: AbortSignal): Promise<ExtractedContent> {
	// Raw blob shortcut: github.com/<owner>/<repo>/blob/<ref>/<path>
	const blobMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
	if (blobMatch) {
		const [, owner, repo, ref, path] = blobMatch;
		const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
		const text = await fetchText(raw, signal);
		return { markdown: cap(text), host, source: "github" };
	}
	const html = await fetchText(url, signal);
	const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html;
	return { markdown: cap(htmlToMarkdown(main)), host, source: "github" };
}

async function extractArxiv(url: string, host: string, signal?: AbortSignal): Promise<ExtractedContent> {
	const html = await fetchText(url, signal);
	const title = html.match(/<h1[^>]*class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "";
	const abstract =
		html.match(/<blockquote\b[^>]*class=["'][^"']*abstract[^"']*["'][^>]*>([\s\S]*?)<\/blockquote>/i)?.[1] ?? "";
	const parts: string[] = [];
	if (title)
		parts.push(
			`# ${decodeEntities(stripTags(title))
				.replace(/^Title:\s*/i, "")
				.trim()}`,
		);
	if (abstract)
		parts.push(
			decodeEntities(stripTags(abstract))
				.replace(/^Abstract:\s*/i, "")
				.trim(),
		);
	const md = parts.length > 0 ? parts.join("\n\n") : htmlToMarkdown(html);
	return { markdown: cap(md), host, source: "arxiv" };
}

async function extractStackOverflow(url: string, host: string, signal?: AbortSignal): Promise<ExtractedContent> {
	const html = await fetchText(url, signal);
	const question =
		html.match(/<div\b[^>]*class=["'][^"']*question[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)?.[1] ?? "";
	const answer =
		html.match(/<div\b[^>]*class=["'][^"']*answer[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)?.[1] ?? "";
	const parts: string[] = [];
	if (question) parts.push(`## Question\n\n${htmlToMarkdown(question)}`);
	if (answer) parts.push(`## Top Answer\n\n${htmlToMarkdown(answer)}`);
	const md = parts.length > 0 ? parts.join("\n\n") : htmlToMarkdown(html);
	return { markdown: cap(md), host, source: "stackoverflow" };
}

async function extractMain(
	url: string,
	host: string,
	source: ExtractedContent["source"],
	signal?: AbortSignal,
): Promise<ExtractedContent> {
	const html = await fetchText(url, signal);
	const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html;
	return { markdown: cap(htmlToMarkdown(main)), host, source };
}

async function extractNpm(url: string, host: string, signal?: AbortSignal): Promise<ExtractedContent> {
	const nameMatch = url.match(/npmjs\.com\/package\/((?:@[^/]+\/)?[^/?#]+)/);
	if (!nameMatch) return extractMain(url, host, "generic", signal);
	const name = decodeURIComponent(nameMatch[1]);
	const data = (await fetchJsonRaw(`https://registry.npmjs.org/${name}`, signal)) as Record<string, unknown>;
	const latestVersion = (data["dist-tags"] as Record<string, string> | undefined)?.latest;
	const versions = data.versions as Record<string, Record<string, unknown>> | undefined;
	const manifest = latestVersion && versions ? versions[latestVersion] : undefined;
	const parts: string[] = [];
	parts.push(`# ${name}@${latestVersion ?? "?"}`);
	const description = (manifest?.description ?? data.description) as string | undefined;
	if (description) parts.push(description);
	const homepage = (manifest?.homepage ?? data.homepage) as string | undefined;
	if (homepage) parts.push(`Homepage: ${homepage}`);
	const repository = (manifest?.repository ?? data.repository) as { url?: string } | string | undefined;
	if (repository) {
		const repoUrl = typeof repository === "string" ? repository : repository.url;
		if (repoUrl) parts.push(`Repository: ${repoUrl}`);
	}
	const license = (manifest?.license ?? data.license) as string | undefined;
	if (license) parts.push(`License: ${license}`);
	const readme = (manifest?.readme ?? data.readme) as string | undefined;
	if (readme) parts.push(`\n${readme}`);
	return { markdown: cap(parts.join("\n\n")), host, source: "npm" };
}

async function extractPyPI(url: string, host: string, signal?: AbortSignal): Promise<ExtractedContent> {
	const nameMatch = url.match(/pypi\.org\/project\/([^/?#]+)/);
	if (!nameMatch) return extractMain(url, host, "generic", signal);
	const name = decodeURIComponent(nameMatch[1]);
	const data = (await fetchJsonRaw(`https://pypi.org/pypi/${name}/json`, signal)) as {
		info?: Record<string, unknown>;
	};
	const info = data?.info ?? {};
	const parts: string[] = [];
	parts.push(`# ${(info.name as string) ?? name} ${(info.version as string) ?? ""}`.trim());
	const summary = info.summary as string | undefined;
	if (summary) parts.push(summary);
	const homepage = info.home_page as string | undefined;
	if (homepage) parts.push(`Homepage: ${homepage}`);
	const projectUrls = info.project_urls as Record<string, string> | undefined;
	if (projectUrls) {
		for (const [k, v] of Object.entries(projectUrls)) {
			parts.push(`${k}: ${v}`);
		}
	}
	const license = info.license as string | undefined;
	if (license) parts.push(`License: ${license}`);
	const desc = info.description as string | undefined;
	if (desc) parts.push(`\n${desc}`);
	return { markdown: cap(parts.join("\n\n")), host, source: "pypi" };
}

async function extractCratesIo(url: string, host: string, signal?: AbortSignal): Promise<ExtractedContent> {
	const nameMatch = url.match(/crates\.io\/crates\/([^/?#]+)/);
	if (!nameMatch) return extractMain(url, host, "generic", signal);
	const name = decodeURIComponent(nameMatch[1]);
	const data = (await fetchJsonRaw(`https://crates.io/api/v1/crates/${name}`, signal)) as {
		crate?: Record<string, unknown>;
	};
	const c = data?.crate ?? {};
	const parts: string[] = [];
	parts.push(`# ${(c.name as string) ?? name} ${(c.max_version as string) ?? ""}`.trim());
	const description = c.description as string | undefined;
	if (description) parts.push(description);
	const homepage = c.homepage as string | undefined;
	if (homepage) parts.push(`Homepage: ${homepage}`);
	const documentation = c.documentation as string | undefined;
	if (documentation) parts.push(`Documentation: ${documentation}`);
	const repository = c.repository as string | undefined;
	if (repository) parts.push(`Repository: ${repository}`);
	const downloads = c.downloads as number | undefined;
	if (typeof downloads === "number") parts.push(`Downloads: ${downloads}`);
	return { markdown: cap(parts.join("\n\n")), host, source: "crates.io" };
}

export async function extractFromUrl(url: string, signal?: AbortSignal): Promise<ExtractedContent> {
	const host = parseHost(url);

	if (host === "github.com" || host === "www.github.com") {
		return extractGitHub(url, host, signal);
	}
	if (host === "arxiv.org" || host === "www.arxiv.org") {
		return extractArxiv(url, host, signal);
	}
	if (host === "stackoverflow.com" || host.endsWith(".stackoverflow.com")) {
		return extractStackOverflow(url, host, signal);
	}
	if (host === "developer.mozilla.org") {
		return extractMain(url, host, "mdn", signal);
	}
	if (host === "docs.rs") {
		return extractMain(url, host, "docs.rs", signal);
	}
	if (host === "npmjs.com" || host === "www.npmjs.com") {
		return extractNpm(url, host, signal);
	}
	if (host === "pypi.org" || host === "www.pypi.org") {
		return extractPyPI(url, host, signal);
	}
	if (host === "crates.io") {
		return extractCratesIo(url, host, signal);
	}
	return extractMain(url, host, "generic", signal);
}
