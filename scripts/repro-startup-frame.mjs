// Repro: render the real interactive startup frame without a TTY.
// Fakes TTY on stdin/stdout, fixes the viewport at 100x40, runs main() under
// PIT_STARTUP_BENCHMARK=1 (init -> render -> stop), and dumps every line the
// TUI emitted, ANSI-stripped, with column markers so off-screen artifacts
// (orphan ellipsis etc.) are visible.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const WIDTH = 100;
const HEIGHT = 40;

process.env.FORCE_COLOR = "1";

// --- fake TTY ---------------------------------------------------------------
Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
process.stdin.setRawMode = () => process.stdin;
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: WIDTH, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: HEIGHT, configurable: true });

// --- capture stdout ----------------------------------------------------------
let captured = "";
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, enc, cb) => {
	captured += typeof chunk === "string" ? chunk : chunk.toString("utf8");
	if (typeof enc === "function") enc();
	else if (typeof cb === "function") cb();
	return true;
};

process.on("exit", dump);

function stripAnsi(s) {
	// CSI / OSC / charset / single-char escapes
	return s
		.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
		.replace(/\x1b[()][0-9A-B]/g, "")
		.replace(/\x1b[=>78]/g, "");
}

function dump() {
	process.stdout.write = realWrite;
	const plain = stripAnsi(captured);
	const lines = plain.split(/\r?\n/);
	const out = [];
	out.push(`=== captured ${captured.length} bytes, ${lines.length} lines (viewport ${WIDTH}x${HEIGHT}) ===`);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].replace(/\r/g, "");
		if (line.trim() === "") continue;
		out.push(String(i).padStart(3) + "|" + line + "|");
	}
	realWrite(out.join("\n") + "\n");
}

setTimeout(() => process.exit(0), 3000);

const { main } = await import("../packages/coding-agent/src/main.ts");
await main([]);
