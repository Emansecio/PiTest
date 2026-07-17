import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { createDestructiveCommandGuardExtension } from "../src/core/built-ins/destructive-command-guard-extension.ts";
import { groundDestructiveCommand, isDestructiveCommandGuardDisabled } from "../src/core/destructive-command-guard.js";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

function blocks(command: string): boolean {
	return groundDestructiveCommand({ command }).action === "block";
}

function messageFor(command: string): string {
	const d = groundDestructiveCommand({ command });
	return d.action === "block" ? d.message : "";
}

type Handler = (event: any) => unknown;
function makeFakePi() {
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	const fire = (event: string, payload: any): any => {
		let result: any;
		for (const handler of handlers.get(event) ?? []) {
			const r = handler(payload);
			if (r !== undefined && result === undefined) result = r;
		}
		return result;
	};
	return { api, fire };
}
const bashCall = (command: string) => ({ toolName: "bash", input: { command } });

describe("destructive-command-guard: rm -rf", () => {
	it("blocks a recursive force delete of a non-regenerable path", () => {
		expect(blocks("rm -rf ./src")).toBe(true);
		expect(messageFor("rm -rf ./src")).toMatch(/src/);
		expect(messageFor("rm -rf ./src")).toMatch(/re-issue the identical call/i);
	});

	it("allows recursive delete of regenerable build dirs (no noise)", () => {
		expect(blocks("rm -rf node_modules")).toBe(false);
		expect(blocks("rm -rf ./dist ./build")).toBe(false);
		expect(blocks("rm -rf node_modules/ coverage .next target")).toBe(false);
	});

	it("blocks when ANY target is non-regenerable, even mixed with regenerable ones", () => {
		expect(blocks("rm -rf node_modules src")).toBe(true);
		expect(messageFor("rm -rf node_modules src")).toMatch(/src/);
	});

	it("defers catastrophic root/home targets to the permission deny-floor (allows here)", () => {
		expect(blocks("rm -rf /")).toBe(false);
		expect(blocks("rm -rf ~")).toBe(false);
	});

	it("ignores non-recursive rm and plain commands", () => {
		expect(blocks("rm file.txt")).toBe(false);
		expect(blocks("rm -f stale.log")).toBe(false);
		expect(blocks("ls -la")).toBe(false);
		expect(blocks("echo rm -rf src")).toBe(false);
	});

	it("sees an rm in any segment of a chained command", () => {
		expect(blocks("npm run build && rm -rf src")).toBe(true);
		expect(blocks("npm run build && rm -rf dist")).toBe(false);
	});

	it("handles a sudo / flag-cluster prefix", () => {
		expect(blocks("sudo rm -fr ./important")).toBe(true);
	});
});

describe("destructive-command-guard: git", () => {
	it("blocks git reset --hard (with or without a target)", () => {
		expect(blocks("git reset --hard")).toBe(true);
		expect(blocks("git reset --hard HEAD~3")).toBe(true);
		expect(blocks("git reset -q --hard origin/main")).toBe(true);
	});

	it("allows a soft/mixed reset", () => {
		expect(blocks("git reset --soft HEAD~1")).toBe(false);
		expect(blocks("git reset HEAD file.txt")).toBe(false);
	});

	it("blocks git clean -f variants but allows a dry run", () => {
		expect(blocks("git clean -fd")).toBe(true);
		expect(blocks("git clean -fdx")).toBe(true);
		expect(blocks("git clean -n")).toBe(false);
	});

	it("blocks discarding the working tree", () => {
		expect(blocks("git checkout .")).toBe(true);
		expect(blocks("git checkout -- .")).toBe(true);
		expect(blocks("git restore .")).toBe(true);
		expect(blocks("git restore --staged --worktree .")).toBe(true);
	});

	it("allows ordinary checkout/restore", () => {
		expect(blocks("git checkout main")).toBe(false);
		expect(blocks("git checkout -b feature")).toBe(false);
		expect(blocks("git restore --staged file.ts")).toBe(false);
	});

	it("blocks force push but allows --force-with-lease and normal push", () => {
		expect(blocks("git push --force")).toBe(true);
		expect(blocks("git push -f origin main")).toBe(true);
		expect(blocks("git push origin main --force")).toBe(true);
		expect(blocks("git push --force-with-lease")).toBe(false);
		expect(blocks("git push origin main")).toBe(false);
	});
});

describe("destructive-command-guard: invariants", () => {
	it("fails open on empty / non-string input", () => {
		expect(blocks("")).toBe(false);
		expect(blocks("   ")).toBe(false);
		expect(groundDestructiveCommand({ command: undefined as unknown as string }).action).toBe("allow");
	});

	it("combines multiple impacts into one message", () => {
		const msg = messageFor("git reset --hard && rm -rf ./src");
		expect(msg).toMatch(/reset --hard/);
		expect(msg).toMatch(/src/);
	});

	it("opt-out flag is read from env", () => {
		expect(isDestructiveCommandGuardDisabled({ PIT_NO_DESTRUCTIVE_GUARD: "1" } as NodeJS.ProcessEnv)).toBe(true);
		expect(isDestructiveCommandGuardDisabled({} as NodeJS.ProcessEnv)).toBe(false);
	});
});

describe("destructive-command-guard: command-substitution opacity", () => {
	const OPAQUE: ReadonlyArray<[string, string]> = [
		["rm -rf $(cat targets.txt)", "rm target via $()"],
		["rm -rf `cat targets.txt`", "rm target via backticks"],
		["rm -rf ./src/$(date +%s)", "rm target partly substituted"],
		["eval rm -rf ./src", "eval-wrapped rm"],
		['bash -c "rm -rf ./src"', "bash -c wrapped rm"],
		["sh -c 'git reset --hard'", "sh -c wrapped git reset"],
		["Remove-Item -Recurse -Force $(Get-Content list.txt)", "PowerShell Remove-Item substituted target"],
	];
	it.each(OPAQUE)("blocks %s (%s) with a substitution note", (command) => {
		expect(blocks(command)).toBe(true);
		expect(messageFor(command)).toMatch(/command substitution|eval\/bash -c/i);
		expect(messageFor(command)).toMatch(/re-issue the identical call/i);
	});

	it("does NOT flag substitution in non-destructive commands", () => {
		expect(blocks("echo $(date)")).toBe(false);
		expect(blocks("echo `whoami`")).toBe(false);
		expect(blocks("ls $(pwd)")).toBe(false);
		expect(blocks('bash -c "npm run build"')).toBe(false);
		expect(blocks("VERSION=$(node -p 1) npm publish")).toBe(false);
	});

	it("prefers the substitution note over a mangled target note (single clean impact)", () => {
		const msg = messageFor("rm -rf $(cat list)");
		expect(msg).toMatch(/command substitution/i);
		expect(msg).not.toMatch(/recursive delete of/i);
	});
});

describe("destructive-command-guard: PowerShell / cmd vocabulary", () => {
	it("blocks Remove-Item with -Recurse and/or -Force on a non-trivial path", () => {
		expect(blocks("Remove-Item -Recurse -Force .\\src")).toBe(true);
		expect(blocks("Remove-Item -Recurse ./app")).toBe(true);
		expect(blocks("Remove-Item -Force config.json")).toBe(true);
		expect(blocks("Remove-Item -r -Path ./lib")).toBe(true);
		expect(messageFor("Remove-Item -Recurse -Force .\\src")).toMatch(/src/);
	});

	it("recognizes PowerShell forms after a powershell -Command / pwsh -c wrapper", () => {
		expect(blocks('powershell -Command "Remove-Item -Recurse -Force ./src"')).toBe(true);
		expect(blocks("pwsh -c 'Remove-Item -Recurse -Force ./src'")).toBe(true);
	});

	it("allows a benign Remove-Item without -Recurse/-Force", () => {
		expect(blocks("Remove-Item ./notes.txt")).toBe(false);
		expect(blocks("Remove-Item -Path build.log")).toBe(false);
	});

	it("allows Remove-Item -Recurse -Force of regenerable dirs (no noise)", () => {
		expect(blocks("Remove-Item -Recurse -Force node_modules")).toBe(false);
		expect(blocks("Remove-Item -Recurse -Force ./dist")).toBe(false);
	});

	it("defers catastrophic drive-root / home targets to the permission deny-floor", () => {
		expect(blocks("Remove-Item -Recurse -Force C:\\")).toBe(false);
		expect(blocks("Remove-Item -Recurse -Force /")).toBe(false);
		expect(blocks("Remove-Item -Recurse -Force ~")).toBe(false);
	});

	it("blocks rd /s and rmdir /s on a non-trivial path", () => {
		expect(blocks("rd /s /q .\\src")).toBe(true);
		expect(blocks("rmdir /s /q app")).toBe(true);
		expect(blocks("rd /s /q .\\dist")).toBe(false);
		expect(blocks("rd .\\src")).toBe(false); // no /s -> not recursive
	});

	it("blocks del /s /f /q on a non-trivial path", () => {
		expect(blocks("del /s /f /q .\\logs")).toBe(true);
		expect(blocks("del /s /q *.tmp")).toBe(true);
		expect(blocks("del stale.log")).toBe(false); // no /s -> not recursive
	});

	it("blocks Clear-Content on a glob but allows a single file", () => {
		expect(blocks("Clear-Content .\\logs\\*.log")).toBe(true);
		expect(blocks("Clear-Content -Path *")).toBe(true);
		expect(blocks("Clear-Content notes.txt")).toBe(false);
	});
});

describe("destructive-command-guard: self-terminating process kills", () => {
	it("blocks taskkill /IM of a host runtime image — the exact incident command", () => {
		// Git Bash mangles cmd flags to `//F` etc.; the guard must handle both.
		expect(blocks("taskkill //F //IM node.exe //T")).toBe(true);
		expect(blocks("taskkill /F /IM node.exe /T")).toBe(true);
		expect(blocks("taskkill /IM pit.exe")).toBe(true);
		expect(blocks("taskkill //F //IM claude.exe")).toBe(true);
		expect(blocks("taskkill /F /IM *")).toBe(true); // wildcard kills everything
	});

	it("names the runtime and the terminal-corruption reason in the message", () => {
		const msg = messageFor("taskkill //F //IM node.exe //T");
		expect(msg).toMatch(/node\.exe/);
		expect(msg).toMatch(/Pit host/);
		expect(msg).toMatch(/TerminateProcess/);
		expect(msg).toMatch(/netstat -ano/); // points at the correct narrow alternative
	});

	it("blocks a force tree-kill of a specific PID (can't prove it isn't the host tree)", () => {
		// The FATAL command in the incident: taskkill //F //PID <n> //T.
		expect(blocks("taskkill //F //PID 27156 //T")).toBe(true);
		expect(blocks("taskkill /F /PID 14784 /T")).toBe(true);
		expect(messageFor("taskkill //F //PID 27156 //T")).toMatch(/process TREE/);
	});

	it("allows a narrow, non-force PID kill and a non-host image", () => {
		expect(blocks("taskkill /PID 27156")).toBe(false); // no force, no tree, no host image
		expect(blocks("taskkill /F /PID 27156")).toBe(false); // force but no /T -> no tree descent
		expect(blocks("taskkill /F /IM chrome.exe")).toBe(false); // not a Pit host runtime
		expect(blocks("taskkill /F /IM someserver.exe /T")).toBe(false);
	});

	it("blocks pkill/killall of a host runtime (the unix analog from Git Bash)", () => {
		expect(blocks("pkill -9 node")).toBe(true);
		expect(blocks("killall node")).toBe(true);
		expect(blocks("pkill tsx")).toBe(true);
		expect(messageFor("pkill -9 node")).toMatch(/Pit host/);
	});

	it("allows pkill/killall of an unrelated process", () => {
		expect(blocks("pkill -9 chrome")).toBe(false);
		expect(blocks("killall nginx")).toBe(false);
	});

	it("catches a host-runtime kill hidden behind command substitution", () => {
		expect(blocks("taskkill //F //IM node.exe //PID $(cat pid.txt)")).toBe(true);
	});
});

describe("destructive-command-guard extension: fire-once", () => {
	it("blocks a destructive+substitution call once, then allows the identical re-issue", () => {
		const { api, fire } = makeFakePi();
		createDestructiveCommandGuardExtension()(api);
		const first = fire("tool_call", bashCall("rm -rf $(cat targets.txt)"));
		expect(first?.block).toBe(true);
		expect(String(first?.reason)).toMatch(/command substitution/i);
		// fire-once escape: re-issuing the identical command runs it.
		expect(fire("tool_call", bashCall("rm -rf $(cat targets.txt)"))).toBeUndefined();
	});

	it("blocks a PowerShell Remove-Item once, then allows the identical re-issue", () => {
		const { api, fire } = makeFakePi();
		createDestructiveCommandGuardExtension()(api);
		const first = fire("tool_call", bashCall("Remove-Item -Recurse -Force ./src"));
		expect(first?.block).toBe(true);
		// fire-once escape.
		expect(fire("tool_call", bashCall("Remove-Item -Recurse -Force ./src"))).toBeUndefined();
	});

	it("records blocked then overridden diagnostics tagged with the destructive-command ruleId", () => {
		resetRuntimeDiagnostics();
		const { api, fire } = makeFakePi();
		createDestructiveCommandGuardExtension()(api);
		fire("tool_call", bashCall("rm -rf ./src"));
		fire("tool_call", bashCall("rm -rf ./src")); // identical re-issue -> override
		const events = getRuntimeDiagnostics().recent.filter((e) => e.category === "guard.destructive-command");
		expect(events.map((e) => e.context?.outcome)).toEqual(["blocked", "overridden"]);
		expect(events.every((e) => e.context?.ruleId === "destructive-command")).toBe(true);
	});
});
