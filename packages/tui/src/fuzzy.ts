/**
 * Fuzzy matching utilities.
 * Matches if all query characters appear in order (not necessarily consecutive).
 * Lower score = better match.
 */

export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

const BOUNDARY_CHARS = new Set([" ", "\t", "\n", "\r", "-", "_", ".", "/", ":"]);

// Hoisted out of fuzzyMatchPrelowered to avoid allocating a closure per
// (item × token) pair on every keystroke. textLower is passed as a parameter
// instead of captured from the enclosing scope.
function matchQueryAgainst(normalizedQuery: string, textLower: string): FuzzyMatch {
	if (normalizedQuery.length === 0) {
		return { matches: true, score: 0 };
	}

	if (normalizedQuery.length > textLower.length) {
		return { matches: false, score: 0 };
	}

	let queryIndex = 0;
	let score = 0;
	let lastMatchIndex = -1;
	let consecutiveMatches = 0;

	for (let i = 0; i < textLower.length && queryIndex < normalizedQuery.length; i++) {
		if (textLower[i] === normalizedQuery[queryIndex]) {
			const isWordBoundary = i === 0 || BOUNDARY_CHARS.has(textLower[i - 1]!);

			// Reward consecutive matches
			if (lastMatchIndex === i - 1) {
				consecutiveMatches++;
				score -= consecutiveMatches * 5;
			} else {
				consecutiveMatches = 0;
				// Penalize gaps
				if (lastMatchIndex >= 0) {
					score += (i - lastMatchIndex - 1) * 2;
				}
			}

			// Reward word boundary matches
			if (isWordBoundary) {
				score -= 10;
			}

			// Slight penalty for later matches
			score += i * 0.1;

			lastMatchIndex = i;
			queryIndex++;
		}
	}

	if (queryIndex < normalizedQuery.length) {
		return { matches: false, score: 0 };
	}

	if (normalizedQuery === textLower) {
		score -= 100;
	}

	return { matches: true, score };
}

function fuzzyMatchPrelowered(queryLower: string, textLower: string): FuzzyMatch {
	const primaryMatch = matchQueryAgainst(queryLower, textLower);
	if (primaryMatch.matches) {
		return primaryMatch;
	}

	const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
	const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
	let swappedQuery = "";
	if (alphaNumericMatch) {
		swappedQuery = `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`;
	} else if (numericAlphaMatch) {
		swappedQuery = `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`;
	}

	if (!swappedQuery) {
		return primaryMatch;
	}

	const swappedMatch = matchQueryAgainst(swappedQuery, textLower);
	if (!swappedMatch.matches) {
		return primaryMatch;
	}

	return { matches: true, score: swappedMatch.score + 5 };
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	return fuzzyMatchPrelowered(query.toLowerCase(), text.toLowerCase());
}

// Cross-keystroke cache: item → its lowercased text. WeakMap auto-evicts when
// the item is GC'd, so we never invalidate manually. Avoids re-running
// toLowerCase() over the same items on every keystroke in the TUI.
const lowerCache = new WeakMap<object, string>();

function getLowered<T>(item: T, getText: (item: T) => string): string {
	if (typeof item === "object" && item !== null) {
		const cached = lowerCache.get(item as object);
		if (cached !== undefined) return cached;
		const lower = getText(item).toLowerCase();
		lowerCache.set(item as object, lower);
		return lower;
	}
	return getText(item).toLowerCase();
}

/**
 * Filter and sort items by fuzzy match quality (best matches first).
 * Supports space-separated tokens: all tokens must match.
 */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	if (!query.trim()) {
		return items;
	}

	const tokens = query
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0);

	if (tokens.length === 0) {
		return items;
	}

	// Pre-lowercase tokens once instead of repeating toLowerCase() inside
	// fuzzyMatch for every token × item pairing.
	const tokensLower = tokens.map((t) => t.toLowerCase());

	const results: { item: T; totalScore: number }[] = [];

	for (const item of items) {
		const textLower = getLowered(item, getText);
		let totalScore = 0;
		let allMatch = true;

		for (const tokenLower of tokensLower) {
			const match = fuzzyMatchPrelowered(tokenLower, textLower);
			if (match.matches) {
				totalScore += match.score;
			} else {
				allMatch = false;
				break;
			}
		}

		if (allMatch) {
			results.push({ item, totalScore });
		}
	}

	results.sort((a, b) => a.totalScore - b.totalScore);
	return results.map((r) => r.item);
}
