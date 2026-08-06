import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return check();
}

describe.runIf(process.platform === "win32")("bash spare-pool host exit", () => {
	let sparePid: number | undefined;
	const cleanupPaths: string[] = [];

	afterEach(async () => {
		if (sparePid && isPidAlive(sparePid)) {
			try {
				process.kill(sparePid, "SIGKILL");
			} catch {}
			await waitUntil(() => !isPidAlive(sparePid!));
		}
		for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
		sparePid = undefined;
	});

	it("reaps an idle prewarmed shell when its host exits without dispose", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pit-spare-exit-"));
		cleanupPaths.push(dir);
		const pidFile = join(dir, "spare.pid");
		const fixture = join(dir, "spawn-spare.mjs");
		const bashModuleUrl = pathToFileURL(join(process.cwd(), "src/core/tools/bash.ts")).href;
		writeFileSync(
			fixture,
			`import { writeFileSync } from "node:fs";
import { createLocalBashOperations, _peekBashSparePoolForTest } from ${JSON.stringify(bashModuleUrl)};
const ops = createLocalBashOperations({ enableSparePool: true });
await ops.exec("echo warm", process.cwd(), { onData() {} });
const deadline = Date.now() + 2000;
let pid;
while (!pid && Date.now() < deadline) {
  pid = _peekBashSparePoolForTest()[0]?.pid;
  if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
}
if (!pid) throw new Error("spare shell was not created");
writeFileSync(process.argv[2], String(pid));
process.exit(0);`,
			"utf8",
		);

		const host = spawn(process.execPath, ["--import", "tsx", fixture, pidFile], {
			cwd: process.cwd(),
			stdio: "ignore",
			windowsHide: true,
		});
		expect(await waitUntil(() => existsSync(pidFile))).toBe(true);
		sparePid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
		expect(Number.isInteger(sparePid)).toBe(true);
		expect(await waitUntil(() => host.exitCode !== null)).toBe(true);
		expect(await waitUntil(() => !isPidAlive(sparePid!))).toBe(true);
	});
});
