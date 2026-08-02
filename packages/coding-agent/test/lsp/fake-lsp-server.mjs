// Minimal fake LSP server for tests. Speaks JSON-RPC over stdio with
// Content-Length framing and answers the handful of methods the lsp tool
// exercises. Not a real language server — just enough to drive client.ts.

let buf = Buffer.alloc(0);

function send(msg) {
	const content = Buffer.from(JSON.stringify(msg), "utf-8");
	process.stdout.write(`Content-Length: ${content.length}\r\n\r\n`);
	process.stdout.write(content);
}

// Ledger test hook: `DIAG_LINE <n>` in the document text moves the diagnostic
// below to line <n> while leaving its message/source/severity untouched — the
// shape a real server produces when an edit shifts a pre-existing error. Kept
// per URI because didSave carries no text, and a real server likewise answers
// from the document state it already holds.
const diagnosticLineByUri = new Map();

function rememberDiagnosticLine(uri, text) {
	if (!uri || typeof text !== "string") return;
	const m = text.match(/DIAG_LINE\s+(\d+)/);
	if (m) diagnosticLineByUri.set(uri, Number(m[1]));
	else diagnosticLineByUri.delete(uri);
}

function diagnosticsFor(uri) {
	const line = diagnosticLineByUri.get(uri) ?? 0;
	return [
		{
			range: { start: { line, character: 0 }, end: { line, character: 5 } },
			severity: 1,
			message: "fake diagnostic",
			source: "fake",
		},
	];
}

function publishDiagnostics(uri) {
	if (!uri) return;
	// A pull-only server answers on request and never volunteers.
	if (PULL_ONLY) return;
	const emit = () =>
		send({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: { uri, diagnostics: diagnosticsFor(uri) },
		});
	if (PUBLISH_DELAY_MS > 0) setTimeout(emit, PUBLISH_DELAY_MS).unref?.();
	else emit();
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

// `--pull` turns this into a PULL-ONLY server (LSP 3.17): it advertises
// `diagnosticProvider`, answers `textDocument/diagnostic`, and never publishes on
// its own. A push-only client gets nothing from it — which is exactly what makes
// it a decisive fixture for the pull path.
const PULL_ONLY = process.argv.includes("--pull");

// `--pull-broken` advertises the same capability but FAILS every pull, then
// publishes late. It exists to pin the one regression the pull race can cause:
// a failed pull resolving early must not abandon a push still due to arrive.
const PULL_BROKEN = process.argv.includes("--pull-broken");
const PUBLISH_DELAY_MS = PULL_BROKEN ? 120 : 0;

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
				...(PULL_ONLY || PULL_BROKEN
					? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } }
					: {}),
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
			// Full text arrives on didOpen (textDocument.text) and didChange
			// (contentChanges[0].text); didSave carries none — drive cross-file off it.
			const text = msg.params?.textDocument?.text ?? msg.params?.contentChanges?.[0]?.text;
			rememberDiagnosticLine(uri, text);
			publishDiagnostics(uri);
			publishCrossFile(uri, text);
			return;
		}
		case "textDocument/diagnostic": {
			// Only the pull-only build answers. The default build stays push-only so it
			// keeps proving the push path; the broken build fails on purpose.
			if (!PULL_ONLY) {
				send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
				return;
			}
			const uri = msg.params?.textDocument?.uri;
			send({ jsonrpc: "2.0", id: msg.id, result: { kind: "full", items: diagnosticsFor(uri) } });
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
