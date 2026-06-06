import { readFileSync, writeFileSync } from "node:fs";

function patch(file, subs) {
	let c = readFileSync(file, "utf-8");
	subs.forEach(([re, to], i) => {
		if (!re.test(c)) {
			console.error(`NO MATCH #${i} in ${file}: ${re}`);
			process.exit(1);
		}
		c = c.replace(re, to);
	});
	writeFileSync(file, c);
	console.log("patched", file);
}

// Shared: capture the writethrough result outside the mutation lock, then
// attach diagnostics after the lock is released.
const RET = /(\n)(\t+)return withFileMutationQueue\(/;
const RET_TO = "$1$2let __written: string | undefined;$1$2const writeResult = await withFileMutationQueue(";
const CLOSE = /\n(\t+)\);\n(\t+)\},\n(\t+renderCall\(args, theme, context\) \{)/;
const CLOSE_TO =
	"\n$1);\n$1return attachPostWriteDiagnostics(writeResult, absolutePath, __written, cwd, signal);\n$2},\n$3";

// ---- write.ts: format-on-write + diagnostics outside the lock ----
patch("packages/coding-agent/src/core/tools/write.ts", [
	[
		/import \{ getPostWriteDiagnosticsText \} from "\.\.\/lsp\/writethrough\.ts";/,
		'import { attachPostWriteDiagnostics, maybeFormat } from "../lsp/writethrough.ts";',
	],
	[
		/(\/\/ Write the file contents\.\n)(\t+)await ops\.writeFile\(absolutePath, content\);\n(\t+)if \(aborted\) return;\n(\t+)const appendix = await getPostWriteDiagnosticsText\(absolutePath, content, cwd, signal\);\n/,
		"$1$2const formatted = await maybeFormat(absolutePath, content, cwd, signal);\n$2await ops.writeFile(absolutePath, formatted.content);\n$3if (aborted) return;\n$4__written = formatted.content;\n",
	],
	[
		/text: `Successfully wrote \$\{content\.length\} bytes to \$\{path\}\$\{appendix\}`,/,
		'text: `Successfully wrote ${formatted.content.length} bytes to ${path}${formatted.formatted ? " (formatted)" : ""}`,',
	],
	[RET, RET_TO],
	[CLOSE, CLOSE_TO],
]);

// ---- edit.ts: diagnostics outside the lock ----
patch("packages/coding-agent/src/core/tools/edit.ts", [
	[
		/import \{ getPostWriteDiagnosticsText \} from "\.\.\/lsp\/writethrough\.ts";/,
		'import { attachPostWriteDiagnostics } from "../lsp/writethrough.ts";',
	],
	[
		/\/\/ Attach LSP diagnostics \(no-op unless writethrough is enabled\)\.\n\t+const appendix = await getPostWriteDiagnosticsText\(absolutePath, finalContent, cwd, signal\);/,
		"__written = finalContent;",
	],
	[
		/text: `Successfully replaced \$\{edits\.length\} block\(s\) in \$\{path\}\.\$\{appendix\}`,/,
		"text: `Successfully replaced ${edits.length} block(s) in ${path}.`,",
	],
	[RET, RET_TO],
	[CLOSE, CLOSE_TO],
]);

// ---- edit-hashline.ts: diagnostics outside the lock ----
patch("packages/coding-agent/src/core/tools/edit-hashline.ts", [
	[
		/import \{ getPostWriteDiagnosticsText \} from "\.\.\/lsp\/writethrough\.ts";/,
		'import { attachPostWriteDiagnostics } from "../lsp/writethrough.ts";',
	],
	[
		/\/\/ Attach LSP diagnostics \(no-op unless writethrough is enabled\)\.\n\t+const appendix = await getPostWriteDiagnosticsText\(absolutePath, finalContent, cwd, signal\);/,
		"__written = finalContent;",
	],
	[
		/text: `Successfully applied \$\{appliedCount\} hashline edit\(s\) in \$\{path\}\.\$\{appendix\}`,/,
		"text: `Successfully applied ${appliedCount} hashline edit(s) in ${path}.`,",
	],
	[RET, RET_TO],
	[CLOSE, CLOSE_TO],
]);
