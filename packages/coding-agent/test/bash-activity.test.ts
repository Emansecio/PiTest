import { describe, expect, test } from "vitest";
import { classifyBashCommand } from "../src/core/tools/bash-activity.js";

describe("classifyBashCommand", () => {
	test("read-only pipelines (incl. the real-session cases) are navigation", () => {
		expect(classifyBashCommand('cd /x && find . -maxdepth 4 -type d -iname "ned" 2>/dev/null | head')).toBe(
			"navigation",
		);
		expect(classifyBashCommand("cd /x && ls -la 2>/dev/null | grep -i ned")).toBe("navigation");
		expect(classifyBashCommand('cd /x && ls -la 2>/dev/null && echo "---SIZE---" && du -sh . 2>/dev/null')).toBe(
			"navigation",
		);
		expect(classifyBashCommand("cat src/index.ts")).toBe("navigation");
		expect(classifyBashCommand("wc -l file && sort file | uniq")).toBe("navigation");
	});

	test("git read-only subcommands are navigation; mutating ones are actions", () => {
		expect(classifyBashCommand("git status")).toBe("navigation");
		expect(classifyBashCommand("git log --oneline -5")).toBe("navigation");
		expect(classifyBashCommand("git diff HEAD~1")).toBe("navigation");
		expect(classifyBashCommand("git commit -m x")).toBe("action");
		expect(classifyBashCommand("git push")).toBe("action");
		expect(classifyBashCommand("git add .")).toBe("action");
	});

	test("effectful commands are actions", () => {
		expect(classifyBashCommand("npm test")).toBe("action");
		expect(classifyBashCommand("rm -rf dist")).toBe("action");
		expect(classifyBashCommand("mkdir foo && cd foo")).toBe("action");
		expect(classifyBashCommand("node script.js")).toBe("action");
	});

	test("write redirection to a real file is an action; /dev/null discards are not", () => {
		expect(classifyBashCommand('echo "x" > file.txt')).toBe("action");
		expect(classifyBashCommand("cat a >> b")).toBe("action");
		expect(classifyBashCommand("ls > /dev/null 2>&1")).toBe("navigation");
	});

	test("a single effectful segment taints the whole command", () => {
		expect(classifyBashCommand("ls && rm x")).toBe("action");
	});

	test("pure cd / neutral is navigation", () => {
		expect(classifyBashCommand("cd /some/path")).toBe("navigation");
	});
});
