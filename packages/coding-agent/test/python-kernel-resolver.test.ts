import { describe, expect, it } from "vitest";
import { PythonResolutionError, resolvePython } from "../src/core/eval-kernel/python-resolver.js";

describe("resolvePython", () => {
	const fakeFs = (paths: string[]) => {
		const files = new Set(paths);
		return {
			isFile: (path: string) => files.has(path),
			isExecutable: (path: string) => files.has(path),
		};
	};

	it("prefers an explicit override", () => {
		const fs = fakeFs(["/custom/python", "/project/.venv/bin/python"]);
		expect(
			resolvePython({
				cwd: "/project",
				env: { PIT_EVAL_PYTHON: "/custom/python", PATH: "" },
				platform: "linux",
				...fs,
			}),
		).toEqual({ command: "/custom/python", source: "override" });
	});

	it("uses VIRTUAL_ENV, then local environments, then PATH", () => {
		const fs = fakeFs(["/active/bin/python", "/project/.venv/bin/python", "/path/python3"]);
		expect(
			resolvePython({
				cwd: "/project",
				env: { VIRTUAL_ENV: "/active", PATH: "/path" },
				platform: "linux",
				...fs,
			}).source,
		).toBe("virtual-env");

		const localFs = fakeFs(["/project/.venv/bin/python", "/path/python3"]);
		expect(resolvePython({ cwd: "/project", env: { PATH: "/path" }, platform: "linux", ...localFs }).source).toBe(
			"local-.venv",
		);

		const pathFs = fakeFs(["/path/python3"]);
		expect(resolvePython({ cwd: "/project", env: { PATH: "/path" }, platform: "linux", ...pathFs }).command).toBe(
			"/path/python3",
		);
	});

	it("continues past invalid automatic candidates", () => {
		const fs = fakeFs(["/path/python"]);
		expect(
			resolvePython({ cwd: "/project", env: { VIRTUAL_ENV: "/missing", PATH: "/path" }, platform: "linux", ...fs })
				.command,
		).toBe("/path/python");
	});

	it("rejects an invalid explicit override without fallback", () => {
		const fs = fakeFs(["/path/python3"]);
		expect(() =>
			resolvePython({
				cwd: "/project",
				env: { PIT_EVAL_PYTHON: "/missing", PATH: "/path" },
				platform: "linux",
				...fs,
			}),
		).toThrow(PythonResolutionError);
	});

	it("uses Windows interpreter paths and PATH ordering", () => {
		const fs = fakeFs(["C:\\project\\.venv\\Scripts\\python.exe", "C:\\tools\\python3.exe"]);
		expect(
			resolvePython({
				cwd: "C:\\project",
				env: { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" },
				platform: "win32",
				...fs,
			}).command,
		).toBe("C:\\project\\.venv\\Scripts\\python.exe");
	});

	it("reports searched categories when no interpreter exists", () => {
		expect(() => resolvePython({ cwd: "/project", env: { PATH: "" }, platform: "linux", ...fakeFs([]) })).toThrow(
			/\.venv.*venv.*PATH/,
		);
	});
});
