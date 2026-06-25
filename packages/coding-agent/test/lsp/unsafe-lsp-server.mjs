// Test-only LSP server for hardening regressions. It can intentionally return
// locations outside the workspace and can withhold diagnostics to model stale
// diagnostic paths.

let buf = Buffer.alloc(0);
const docs = new Map();
const outsideUriArgIndex = process.argv.indexOf("--outside-uri");
const outsideUri = outsideUriArgIndex >= 0 ? process.argv[outsideUriArgIndex + 1] : undefined;

function send(msg) {
	const content = Buffer.from(JSON.stringify(msg), "utf-8");
	process.stdout.write(`Content-Length: ${content.length}\r\n\r\n`);
	process.stdout.write(content);
}

function diagnosticsFor(text) {
	const diagnostics = [];
	const lines = text.split("\n");
	for (let line = 0; line < lines.length; line++) {
		const oldCol = lines[line].indexOf("OLD_ERROR");
		if (oldCol >= 0) {
			diagnostics.push({
				range: { start: { line, character: oldCol }, end: { line, character: oldCol + "OLD_ERROR".length } },
				severity: 1,
				message: "preexisting issue",
				source: "unsafe-fake",
			});
		}
		const newCol = lines[line].indexOf("NEW_ERROR");
		if (newCol >= 0) {
			diagnostics.push({
				range: { start: { line, character: newCol }, end: { line, character: newCol + "NEW_ERROR".length } },
				severity: 1,
				message: "new issue",
				source: "unsafe-fake",
			});
		}
	}
	return diagnostics;
}

function publishDiagnostics(uri) {
	if (!uri) return;
	const text = docs.get(uri) ?? "";
	if (text.includes("NO_PUBLISH")) return;
	send({
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: { uri, diagnostics: diagnosticsFor(text) },
	});
}

function handle(msg) {
	switch (msg.method) {
		case "initialize":
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					capabilities: {
						definitionProvider: true,
						documentFormattingProvider: true,
					},
				},
			});
			return;
		case "initialized":
			send({ jsonrpc: "2.0", method: "$/progress", params: { token: "load", value: { kind: "begin" } } });
			send({ jsonrpc: "2.0", method: "$/progress", params: { token: "load", value: { kind: "end" } } });
			return;
		case "textDocument/didOpen":
			docs.set(msg.params?.textDocument?.uri, msg.params?.textDocument?.text ?? "");
			publishDiagnostics(msg.params?.textDocument?.uri);
			return;
		case "textDocument/didChange": {
			const uri = msg.params?.textDocument?.uri;
			const text = msg.params?.contentChanges?.[0]?.text ?? "";
			docs.set(uri, text);
			publishDiagnostics(uri);
			return;
		}
		case "textDocument/didSave":
			publishDiagnostics(msg.params?.textDocument?.uri);
			return;
		case "textDocument/definition":
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					uri: outsideUri ?? msg.params.textDocument.uri,
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
				},
			});
			return;
		case "textDocument/formatting":
			send({ jsonrpc: "2.0", id: msg.id, result: [] });
			return;
		case "shutdown":
			send({ jsonrpc: "2.0", id: msg.id, result: null });
			return;
		case "exit":
			process.exit(0);
			return;
		default:
			if (msg.id !== undefined) {
				send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
			}
	}
}

process.stdin.on("data", (chunk) => {
	buf = Buffer.concat([buf, chunk]);
	while (true) {
		const headerEnd = buf.indexOf("\r\n\r\n");
		if (headerEnd === -1) break;
		const header = buf.subarray(0, headerEnd).toString("ascii");
		const match = header.match(/Content-Length: (\d+)/i);
		if (!match) {
			buf = buf.subarray(headerEnd + 4);
			continue;
		}
		const len = Number.parseInt(match[1], 10);
		const start = headerEnd + 4;
		if (buf.length < start + len) break;
		const body = buf.subarray(start, start + len).toString("utf-8");
		buf = buf.subarray(start + len);
		try {
			handle(JSON.parse(body));
		} catch {
			// ignore malformed test input
		}
	}
});
