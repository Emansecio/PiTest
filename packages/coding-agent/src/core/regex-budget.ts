/** Wall-clock budget for a single regex evaluation pass (permission rules, hooks). */
export const REGEX_TEST_BUDGET_MS = 40;

/** Cap haystack length before regex.test to bound worst-case backtracking. */
export const REGEX_TEST_TEXT_CAP = 10_000;

export function createRegexTestDeadline(): number {
	return Date.now() + REGEX_TEST_BUDGET_MS;
}

export function isRegexBudgetExpired(deadlineMs: number): boolean {
	return Date.now() > deadlineMs;
}

/**
 * Run `re.test` when the deadline has not passed. Returns `null` when the budget
 * is exhausted (caller should fail-closed on security gates, fail-open elsewhere).
 */
export function testRegexWithinBudget(re: RegExp, text: string, deadlineMs: number): boolean | null {
	if (isRegexBudgetExpired(deadlineMs)) return null;
	const haystack = text.length > REGEX_TEST_TEXT_CAP ? text.slice(0, REGEX_TEST_TEXT_CAP) : text;
	re.lastIndex = 0;
	return re.test(haystack);
}

/**
 * Like `testRegexWithinBudget`, but returns the match index for relevance scoring.
 * `-1` = no match; `null` = budget exhausted before evaluation.
 */
export function searchRegexWithinBudget(re: RegExp, text: string, deadlineMs: number): number | null {
	if (isRegexBudgetExpired(deadlineMs)) return null;
	const haystack = text.length > REGEX_TEST_TEXT_CAP ? text.slice(0, REGEX_TEST_TEXT_CAP) : text;
	re.lastIndex = 0;
	return haystack.search(re);
}
