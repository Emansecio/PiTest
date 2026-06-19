// Fake DAP adapter variant for the #27 regression: on `continue` it emits an
// `exited` event (with an exit code) but NO `terminated` event. This reproduces
// adapters where `exited` wins the stop-outcome race; the session must still
// report the program as terminated (not "running").

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
			respond(req, { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true });
			event("initialized", {});
			return;
		case "launch":
			respond(req, {});
			event("stopped", { reason: "entry", threadId: 1, allThreadsStopped: true });
			return;
		case "configurationDone":
			respond(req, {});
			return;
		case "threads":
			respond(req, { threads: [{ id: 1, name: "main" }] });
			return;
		case "continue":
			respond(req, { allThreadsContinued: true });
			// Program runs to completion: emit `exited` only (no `terminated`).
			event("exited", { exitCode: 7 });
			return;
		case "terminate":
		case "disconnect":
			respond(req, {});
			if (req.command === "disconnect") setTimeout(() => process.exit(0), 10);
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
