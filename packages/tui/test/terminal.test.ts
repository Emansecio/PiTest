import assert from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.js";

describe("ProcessTerminal keyboard protocol", () => {
	it("sets up input but emits no Kitty or modifyOtherKeys queries for mixed-case TERM=dumb", async () => {
		const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout")!;
		const previousTerm = process.env.TERM;
		const writes: string[] = [];
		const fakeStdout = Object.assign(new EventEmitter(), {
			write: (chunk: unknown) => {
				if (typeof chunk === "string") writes.push(chunk);
				return true;
			},
		});
		Object.defineProperty(process, "stdout", { value: fakeStdout, configurable: true });
		process.env.TERM = "DuMb";
		const input: string[] = [];
		const terminal = new ProcessTerminal();

		try {
			terminal.start(
				(data) => input.push(data),
				() => {},
			);
			process.stdin.emit("data", "x");
			await new Promise((resolve) => setTimeout(resolve, 180));

			assert.deepEqual(input, ["x"], "stdin still passes through StdinBuffer");
			assert.ok(!writes.includes("\x1b[?u"), "must not query Kitty protocol");
			assert.ok(!writes.includes("\x1b[>4;2m"), "must not enable modifyOtherKeys fallback");
		} finally {
			terminal.stop();
			Object.defineProperty(process, "stdout", stdoutDescriptor);
			if (previousTerm === undefined) delete process.env.TERM;
			else process.env.TERM = previousTerm;
		}
	});
});

describe("ProcessTerminal dimensions", () => {
	it("falls back to COLUMNS and LINES before default dimensions", () => {
		const previousColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		const previousRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const previousColumns = process.env.COLUMNS;
		const previousLines = process.env.LINES;

		try {
			Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
			process.env.COLUMNS = "123";
			process.env.LINES = "45";

			const terminal = new ProcessTerminal();

			assert.equal(terminal.columns, 123);
			assert.equal(terminal.rows, 45);
		} finally {
			if (previousColumnsDescriptor) {
				Object.defineProperty(process.stdout, "columns", previousColumnsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "columns");
			}
			if (previousRowsDescriptor) {
				Object.defineProperty(process.stdout, "rows", previousRowsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "rows");
			}
			if (previousColumns === undefined) {
				delete process.env.COLUMNS;
			} else {
				process.env.COLUMNS = previousColumns;
			}
			if (previousLines === undefined) {
				delete process.env.LINES;
			} else {
				process.env.LINES = previousLines;
			}
		}
	});
});
