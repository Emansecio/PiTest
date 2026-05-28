import type { SourceInfo } from "../../core/source-info.ts";
import { parseGitUrl } from "../../utils/git.ts";

export function getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
	if (!sourceInfo) {
		return undefined;
	}

	const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
	const source = sourceInfo.source.trim();

	if (source === "auto" || source === "local" || source === "cli") {
		return scopePrefix;
	}

	if (source.startsWith("npm:")) {
		return `${scopePrefix}:${source}`;
	}

	const gitSource = parseGitUrl(source);
	if (gitSource) {
		const ref = gitSource.ref ? `@${gitSource.ref}` : "";
		return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
	}

	return scopePrefix;
}

export function prefixAutocompleteDescription(
	description: string | undefined,
	sourceInfo?: SourceInfo,
): string | undefined {
	const sourceTag = getAutocompleteSourceTag(sourceInfo);
	if (!sourceTag) {
		return description;
	}
	return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
}
