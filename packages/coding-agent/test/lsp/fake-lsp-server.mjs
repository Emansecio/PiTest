// Minimal fake LSP server for tests. Speaks JSON-RPC over stdio with
// Content-Length framing and answers the handful of methods the lsp tool
// exercises. Not a real language server — just enough to drive client.ts.

let buf = Buffer.alloc(0);

function send(msg) {
	const content = Buffer.from(JSON.stringify(msg), "utf-8");
	process.stdout.write(`Content-Length: ${content.length}\r\n\r\n`);
	process.stdout.write(content);
}

function publishDiagnostics(uri) {
	if (!uri) return;
	send({
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: {
			uri,
			diagnostics: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
					severity: 1,
					message: "fake diagnostic",
					source: "fake",
				},
			],
		},
	});
}

// Derive a sibling URI (same directory) from the edited file's URI.
function siblingUri(editedUri, name) {
	const idx = editedUri.lastIndexOf("/");
	return idx >= 0 ? editedUri.slice(0, idx + 1) + name : name;
}

// Cross-file test hook: the client sends the full document text on didOpen /
// didChange. When that text carries directives, publish diagnostics for OTHER
// URIs (like gopls publishing package-level diagnostics on save) so tests can
// exercise the cross-file surfacing path:
//   CROSS_ERROR <name> [count]  → publish `count` distinct errors for sibling <name>
//   CROSS_CLEAR <name>          → publish an empty (clean) diagnostics set for it
function publishCrossFile(editedUri, text) {
	if (!editedUri || typeof text !== "string") return;
	for (const line of text.split(/\r?\n/)) {
		let m = line.match(/CROSS_ERROR\s+(\S+)(?:\s+(\d+))?/);
		if (m) {
			const name = m[1];
			const count = m[2] ? Number.parseInt(m[2], 10) : 1;
			const diagnostics = [];
			for (let i = 0; i < count; i++) {
				diagnostics.push({
					range: { start: { line: i, character: 0 }, end: { line: i, character: 3 } },
					severity: 1,
					message: `cross error ${i} in ${name}`,
					source: "fake",
				});
			}
			send({
				jsonrpc: "2.0",
				method: "textDocument/publishDiagnostics",
				params: { uri: siblingUri(editedUri, name), diagnostics },
			});
			continue;
		}
		m = line.match(/CROSS_CLEAR\s+(\S+)/);
		if (m) {
			send({
				jsonrpc: "2.0",
				method: "textDocument/publishDiagnostics",
				params: { uri: siblingUri(editedUri, m[1]), diagnostics: [] },
			});
		}
	}
}

// Test hook: delay the `initialize` reply so a test can race shutdown against a
// still-warming-up client. Off unless FAKE_LSP_INIT_DELAY_MS is set.
const INIT_DELAY_MS = Number.parseInt(process.env.FAKE_LSP_INIT_DELAY_MS ?? "0", 10) || 0;

function handleInitialize(msg) {
	send({
		jsonrpc: "2.0",
		id: msg.id,
		result: {
			capabilities: {
				hoverProvider: true,
				definitionProvider: true,
				typeDefinitionProvider: true,
				implementationProvider: true,
				referencesProvider: true,
				renameProvider: { prepareProvider: true },
				documentSymbolProvider: true,
				workspaceSymbolProvider: true,
				codeActionProvider: true,
				documentFormattingProvider: true,
			},
		},
	});
}

function handle(msg) {
	if (msg.method === "initialize" && INIT_DELAY_MS > 0) {
		setTimeout(() => handleInitialize(msg), INIT_DELAY_MS);
		return;
	}
	switch (msg.method) {
		case "initialize":
			handleInitialize(msg);
			return;
		case "initialized":
			// Resolve project-load tracking fast so cross-file actions don't wait.
			send({ jsonrpc: "2.0", method: "$/progress", params: { token: "load", value: { kind: "begin" } } });
			send({ jsonrpc: "2.0", method: "$/progress", params: { token: "load", value: { kind: "end" } } });
			return;
		case "textDocument/didOpen":
		case "textDocument/didChange":
		case "textDocument/didSave": {
			const uri = msg.params?.textDocument?.uri;
			publishDiagnostics(uri);
			// Full text arrives on didOpen (textDocument.text) and didChange
			// (contentChanges[0].text); didSave carries none — drive cross-file off it.
			const text = msg.params?.textDocument?.text ?? msg.params?.contentChanges?.[0]?.text;
			publishCrossFile(uri, text);
			return;
		}
		case "textDocument/hover":
			send({ jsonrpc: "2.0", id: msg.id, result: { contents: { kind: "markdown", value: "HOVER: fake type info" } } });
			return;
		case "textDocument/definition":
		case "textDocument/typeDefinition":
		case "textDocument/implementation": {
			const uri = msg.params.textDocument.uri;
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result: { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
			});
			return;
		}
		case "textDocument/references": {
			const uri = msg.params.textDocument.uri;
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result: [
					{ uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
					{ uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } },
				],
			});
			return;
		}
		case "textDocument/documentSymbol":
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result: [
					{
						name: "fakeSym",
						kind: 12,
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
						selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
					},
				],
			});
			return;
		case "textDocument/prepareRename": {
			const pos = msg.params?.position ?? { line: 0, character: 0 };
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					range: { start: pos, end: pos },
					placeholder: "hello",
				},
			});
			return;
		}
		case "textDocument/rename": {
			const uri = msg.params.textDocument.uri;
			const newName = msg.params.newName;
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					changes: {
						[uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: newName }],
					},
				},
			});
			return;
		}
		case "textDocument/codeAction":
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result: [{ title: "Fix the fake diagnostic", kind: "quickfix" }],
			});
			return;
		case "workspace/symbol":
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result: [
					{
						name: "fakeSym",
						kind: 12,
						location: {
							uri: msg.fileUri ?? "file:///fake.txt",
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
						},
					},
				],
			});
			return;
		case "textDocument/formatting":
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result: [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "/* fmt */ " },
				],
			});
			return;
		case "shutdown":
			send({ jsonrpc: "2.0", id: msg.id, result: null });
			return;
		case "exit":
			process.exit(0);
			return;
		default:
			if (typeof msg.id === "number") {
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
		const m = header.match(/Content-Length: (\d+)/i);
		if (!m) {
			buf = buf.subarray(headerEnd + 4);
			continue;
		}
		const len = Number.parseInt(m[1], 10);
		const start = headerEnd + 4;
		if (buf.length < start + len) break;
		const body = buf.subarray(start, start + len).toString("utf-8");
		buf = buf.subarray(start + len);
		let msg;
		try {
			msg = JSON.parse(body);
		} catch {
			continue;
		}
		handle(msg);
	}
});
