/** Parse the JSON-with-comments format accepted by Pit configuration files. */
export function parseJsonc(text: string): unknown {
	const json = text
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ""));
	return JSON.parse(json);
}
