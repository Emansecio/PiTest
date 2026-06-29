/**
 * User/model-facing diagnostic status strings. Imperative wording stops weak
 * models from treating "unavailable" as "OK".
 */

export function formatDiagnosticsUnavailableMessage(relPath: string, serverIssues: string): string {
	const detail = serverIssues.length > 0 ? serverIssues : "no fresh diagnostics published";
	return (
		`Diagnostics unavailable for ${relPath}: ${detail}. ` +
		`Do not assume this file is error-free — retry lsp diagnostics after indexing completes, ` +
		`or read the file and fix any issues you introduced.`
	);
}

export function formatBatchDiagnosticsUnavailable(relPath: string, issueNote: string): string {
	return `${relPath}: diagnostics unavailable${issueNote}. Treat as unknown, not clean.`;
}
