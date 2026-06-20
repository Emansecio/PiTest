import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecipeToolDefinition, quoteRecipeShellArg, resolveSpawnStrategy } from "../src/core/tools/recipe.js";

const isWindows = process.platform === "win32";

/** Extract the text of the single text content block a recipe result returns. */
function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content[0];
	return block && block.type === "text" && typeof block.text === "string" ? block.text : "";
}

describe("recipe — Windows shell quoting (injection / arg-splitting)", () => {
	describe("quoteRecipeShellArg", () => {
		it("leaves plain tokens unquoted", () => {
			expect(quoteRecipeShellArg("build")).toBe("build");
			expect(quoteRecipeShellArg("test-unit")).toBe("test-unit");
		});

		it("quotes tokens with whitespace so they stay one argument", () => {
			expect(quoteRecipeShellArg("filtro com espaco")).toBe('"filtro com espaco"');
		});

		it("quotes tokens containing cmd.exe metacharacters (no whitespace needed)", () => {
			// These have no whitespace but MUST be quoted, or cmd.exe re-interprets them.
			expect(quoteRecipeShellArg("plain&inject")).toBe('"plain&inject"');
			expect(quoteRecipeShellArg("a|b")).toBe('"a|b"');
			expect(quoteRecipeShellArg("a>b")).toBe('"a>b"');
			expect(quoteRecipeShellArg("a<b")).toBe('"a<b"');
			expect(quoteRecipeShellArg("a^b")).toBe('"a^b"');
			expect(quoteRecipeShellArg("a(b)")).toBe('"a(b)"');
		});

		it("doubles embedded quotes", () => {
			expect(quoteRecipeShellArg('has"quote')).toBe('"has""quote"');
		});
	});

	describe("resolveSpawnStrategy", () => {
		it("never uses a shell on POSIX", () => {
			if (isWindows) return; // POSIX-only assertion
			const s = resolveSpawnStrategy("sh", ["-c", "a & echo x"]);
			expect(s.useShell).toBe(false);
			// Args are passed through untouched (execvp does not re-parse them).
			expect(s.args).toEqual(["-c", "a & echo x"]);
		});

		it("on Windows resolves node to a real .exe and uses shell:false (no quoting)", () => {
			if (!isWindows) return; // Windows-only assertion
			const s = resolveSpawnStrategy("node", ["a & echo x", "filtro com espaco"]);
			expect(s.useShell).toBe(false);
			// .exe path => raw args array, NOT shell-quoted.
			expect(s.args).toEqual(["a & echo x", "filtro com espaco"]);
			expect(s.command.toLowerCase()).toContain("node");
		});

		it("on Windows routes a .cmd shim through the shell with strict quoting", async () => {
			if (!isWindows) return; // Windows-only assertion
			const dir = await mkdtemp(join(tmpdir(), "pit-recipe-which-"));
			try {
				const shim = join(dir, "fakerunner.cmd");
				await writeFile(shim, "@echo off\r\nexit 0\r\n");
				const prevPath = process.env.PATH;
				process.env.PATH = `${dir};${prevPath}`;
				try {
					const s = resolveSpawnStrategy("fakerunner", ["a & echo x", "plain&inject"]);
					expect(s.useShell).toBe(true);
					// .cmd shim => every token quoted (both metachar args wrapped).
					expect(s.args).toEqual(['"a & echo x"', '"plain&inject"']);
				} finally {
					process.env.PATH = prevPath;
				}
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});
	});
});

/**
 * End-to-end through the real `recipe` tool, using a temp Makefile whose target
 * echoes the argv it received. The runner used is a temp `.cmd` shim on Windows
 * (covers the shell path) so we exercise the actual quoting in production.
 *
 * We can only run this when a `make`-like runner exists. To make it deterministic
 * and self-contained we install a fake `make` shim onto PATH that records argv.
 */
describe("recipe — end-to-end argv fidelity", () => {
	let dir: string;
	let binDir: string;
	let prevPath: string | undefined;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pit-recipe-e2e-"));
		binDir = await mkdtemp(join(tmpdir(), "pit-recipe-bin-"));
		prevPath = process.env.PATH;
		process.env.PATH = `${binDir}${isWindows ? ";" : ":"}${prevPath}`;
		// A Makefile presence makes detectRunner pick `make`.
		await writeFile(join(dir, "Makefile"), "build:\n\t@echo built\n");
	});

	afterEach(async () => {
		process.env.PATH = prevPath;
		await rm(dir, { recursive: true, force: true });
		await rm(binDir, { recursive: true, force: true });
	});

	it("passes a metacharacter arg as literal data, not an injected command", async () => {
		// Fake `make` that echoes each argv element on its own line (no real make).
		const outFile = join(dir, "argv.txt");
		if (isWindows) {
			// .cmd shim => forces the Windows shell path of runRunner.
			const echoer = join(binDir, "echoargv.mjs");
			await writeFile(
				echoer,
				`import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(outFile)}, process.argv.slice(2).join("\\n"));\n`,
			);
			await writeFile(join(binDir, "make.cmd"), `@echo off\r\nnode "${echoer}" %*\r\n`);
		} else {
			const sh = join(binDir, "make");
			await writeFile(sh, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(outFile)}\n`);
			execFileSync("chmod", ["+x", sh]);
		}

		const tool = createRecipeToolDefinition(dir);
		// The injection probe: a target with `& <command>` must NOT run <command>.
		const injectedMarker = "PWNED_INJECTION_MARKER";
		const result = await tool.execute(
			"t1",
			{ target: "build", args: [`x & echo ${injectedMarker}`] },
			undefined,
			undefined,
			undefined as never,
		);

		const text = resultText(result);
		// The injected echo must not have executed: its marker must not appear as
		// separate command output. (It may appear quoted as an arg value below.)
		const { readFileSync } = await import("node:fs");
		const recordedArgv = readFileSync(outFile, "utf8").split("\n").filter(Boolean);
		// `make` receives: build, then either `--`-less forwarded arg. detectRunner
		// for Makefile does [target, ...extraArgs] => ["build", "x & echo PWNED..."].
		expect(recordedArgv).toContain(`x & echo ${injectedMarker}`);
		// And it arrived as exactly ONE argv element, not split on the space or `&`.
		const injectedAsOne = recordedArgv.filter((a) => a.includes(injectedMarker));
		expect(injectedAsOne).toHaveLength(1);
		expect(injectedAsOne[0]).toBe(`x & echo ${injectedMarker}`);
		// The tool output must not show the injected echo as its own command line.
		expect(text).not.toMatch(new RegExp(`^${injectedMarker}$`, "m"));
	});

	it("passes a space-containing arg as a single argument (no splitting)", async () => {
		const outFile = join(dir, "argv2.txt");
		if (isWindows) {
			const echoer = join(binDir, "echoargv2.mjs");
			await writeFile(
				echoer,
				`import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(outFile)}, process.argv.slice(2).join("\\n"));\n`,
			);
			await writeFile(join(binDir, "make.cmd"), `@echo off\r\nnode "${echoer}" %*\r\n`);
		} else {
			const sh = join(binDir, "make");
			await writeFile(sh, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(outFile)}\n`);
			execFileSync("chmod", ["+x", sh]);
		}

		const tool = createRecipeToolDefinition(dir);
		await tool.execute(
			"t2",
			{ target: "build", args: ["filtro com espaco"] },
			undefined,
			undefined,
			undefined as never,
		);

		const { readFileSync } = await import("node:fs");
		const recordedArgv = readFileSync(outFile, "utf8").split("\n").filter(Boolean);
		expect(recordedArgv).toContain("filtro com espaco");
		// Exactly one element holds the spaced value -- it was not split into 3.
		expect(recordedArgv.filter((a) => a === "filtro com espaco")).toHaveLength(1);
		expect(recordedArgv).not.toContain("filtro");
	});

	it("still reports a missing binary as exit 127 (ENOENT preserved)", async () => {
		// No runner installed for this manifest type. Use Cargo.toml + a target that
		// is a known subcommand, but ensure `cargo` is not resolvable by clearing it
		// from PATH for this case.
		process.env.PATH = isWindows ? "C:\\Windows\\System32" : "/nonexistent-bin-dir";
		const tool = createRecipeToolDefinition(dir);
		// Makefile is present but `make` is gone from PATH now.
		const result = (await tool.execute(
			"t3",
			{ target: "build" },
			undefined,
			undefined,
			undefined as never,
		)) as unknown as {
			content: Array<{ type: string; text?: string }>;
			isError: boolean;
		};
		const text = resultText(result);
		if (!isWindows) {
			// POSIX shell:false => ENOENT => exit 127 with our message.
			expect(text).toContain("exit=127");
			expect(text).toContain("not found in PATH");
		} else {
			// Windows shell fallback: cmd reports the missing command (non-zero exit).
			expect(result.isError).toBe(true);
		}
	});
});
