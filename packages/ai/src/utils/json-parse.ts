import { parse as partialParse } from "partial-json";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
export function repairJson(json: string): string {
	const parts: string[] = [];
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			parts.push(char!);
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (char === '"') {
			parts.push(char);
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				parts.push("\\\\");
				continue;
			}

			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					parts.push(`\\u${unicodeDigits}`);
					index += 5;
					continue;
				}
			}

			if (VALID_JSON_ESCAPES.has(nextChar)) {
				parts.push(`\\${nextChar}`);
				index += 1;
				continue;
			}

			parts.push("\\\\");
			continue;
		}

		parts.push(isControlCharacter(char!) ? escapeControlCharacter(char!) : char!);
	}

	return parts.join("");
}

export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}
		throw error;
	}
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
/**
 * Finalizes streaming JSON into parsed arguments at content_block_stop.
 * Unlike parseStreamingJson, returns a parseError flag when all parsers
 * fail on non-empty input so callers can detect corruption.
 */
export function finalizeStreamingJson<T = Record<string, unknown>>(
	partialJson: string | undefined,
): { value: T; parseError: boolean } {
	if (!partialJson || partialJson.trim() === "") {
		return { value: {} as T, parseError: false };
	}

	try {
		return { value: parseJsonWithRepair<T>(partialJson), parseError: false };
	} catch {
		try {
			const result = partialParse(partialJson);
			return { value: (result ?? {}) as T, parseError: result == null };
		} catch {
			try {
				const result = partialParse(repairJson(partialJson));
				return { value: (result ?? {}) as T, parseError: result == null };
			} catch {
				return { value: {} as T, parseError: true };
			}
		}
	}
}

export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	try {
		return parseJsonWithRepair<T>(partialJson);
	} catch {
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			try {
				const result = partialParse(repairJson(partialJson));
				return (result ?? {}) as T;
			} catch {
				return {} as T;
			}
		}
	}
}
