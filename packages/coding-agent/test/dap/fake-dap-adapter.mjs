// Minimal fake DAP adapter for tests. Speaks the Debug Adapter Protocol over
// stdio with Content-Length framing and answers the requests the session
// manager exercises. Not a real debugger — just enough to drive client+session.

let buf = Buffer.alloc(0);
let seq = 0;

function send(msg) {
	msg.seq = ++seq;
	const content = Buffer.from(JSON.stringify(msg), "utf-8");
	process.stdout.write(`Content-Length: ${content.length}\r\n\r\n`);
	process.stdout.write(content);
}

function respond(request, body, success = true, message) {
	send({ type: "response", request_seq: request.seq, success, command: request.command, body, message });
}

function event(name, body) {
	send({ type: "event", event: name, body });
}

function handle(req) {
	switch (req.command) {
		case "initialize":
			respond(req, {
				supportsConfigurationDoneRequest: true,
				supportsTerminateRequest: true,
				supportsConditionalBreakpoints: true,
				supportsFunctionBreakpoints: true,
			});
			event("initialized", {});
			return;
		case "launch":
			respond(req, {});
			event("stopped", { reason: "entry", threadId: 1, allThreadsStopped: true });
			return;
		case "attach":
			respond(req, {});
			event("stopped", { reason: "entry", threadId: 1 });
			return;
		case "configurationDone":
			respond(req, {});
			return;
		case "setBreakpoints":
			respond(req, {
				breakpoints: (req.arguments?.breakpoints ?? []).map((b, i) => ({ id: i + 1, verified: true, line: b.line })),
			});
			return;
		case "setFunctionBreakpoints":
			respond(req, { breakpoints: (req.arguments?.breakpoints ?? []).map((_b, i) => ({ id: i + 1, verified: true })) });
			return;
		case "threads":
			respond(req, { threads: [{ id: 1, name: "main" }] });
			return;
		case "stackTrace":
			respond(req, {
				stackFrames: [
					{
						id: 1,
						name: "main",
						line: 42,
						column: 1,
						source: { path: "/x/main.c", name: "main.c" },
						instructionPointerReference: "0x1000",
					},
				],
				totalFrames: 1,
			});
			return;
		case "scopes":
			respond(req, { scopes: [{ name: "Locals", variablesReference: 100, expensive: false, presentationHint: "locals" }] });
			return;
		case "variables":
			respond(req, { variables: [{ name: "counter", value: "42", type: "int", variablesReference: 0 }] });
			return;
		case "evaluate":
			respond(req, { result: `EVAL:${req.arguments?.expression ?? ""}`, type: "int", variablesReference: 0 });
			return;
		case "continue":
			respond(req, { allThreadsContinued: true });
			event("output", { category: "stdout", output: "hello from program\n" });
			event("stopped", { reason: "breakpoint", threadId: 1, allThreadsStopped: true });
			return;
		case "next":
		case "stepIn":
		case "stepOut":
			respond(req, {});
			event("stopped", { reason: "step", threadId: 1 });
			return;
		case "pause":
			respond(req, {});
			event("stopped", { reason: "pause", threadId: 1 });
			return;
		case "terminate":
			respond(req, {});
			return;
		case "disconnect":
			respond(req, {});
			setTimeout(() => process.exit(0), 10);
			return;
		default:
			respond(req, undefined, false, `unsupported: ${req.command}`);
	}
}

process.stdin.on("data", (chunk) => {
	buf = Buffer.concat([buf, chunk]);
	while (true) {
		const headerEnd = buf.indexOf("\r\n\r\n");
		if (headerEnd === -1) break;
		const m = buf.subarray(0, headerEnd).toString("ascii").match(/Content-Length: (\d+)/i);
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
		if (msg.type === "request") handle(msg);
	}
});
