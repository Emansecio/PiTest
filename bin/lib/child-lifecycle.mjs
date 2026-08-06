import { spawn, spawnSync } from "node:child_process";

const SIGNAL_EXIT_CODES = {
	SIGHUP: 129,
	SIGINT: 130,
	SIGTERM: 143,
};

function signalExitCode(signal) {
	return SIGNAL_EXIT_CODES[signal] ?? 1;
}

function wait(ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		// If the child exits during the grace period, this timer must not keep
		// the launcher alive until the full delay elapses.
		timer.unref?.();
	});
}

function isPidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function forwardProcessSignal(pid, signal, platform = process.platform) {
	// A Windows console control event is delivered to both launcher and child.
	// The launcher handler only prevents its own default exit while the child
	// performs normal runtime disposal. If the child stays alive, the bounded
	// grace below escalates with taskkill /T /F.
	if (platform === "win32") return;
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {}
	}
}

function killOrphanedWindowsTreeSync(rootPid) {
	const script = [
		"$ErrorActionPreference='Stop'",
		`$rootProcessId=${rootPid}`,
		"$rows=@(Get-CimInstance Win32_Process)",
		"$ids=[Collections.Generic.List[int]]::new()",
		"[void]$ids.Add($rootProcessId)",
		"for($i=0;$i -lt $ids.Count;$i++){foreach($row in $rows){if($row.ParentProcessId -eq $ids[$i] -and -not $ids.Contains([int]$row.ProcessId)){[void]$ids.Add([int]$row.ProcessId)}}}",
		"for($i=$ids.Count-1;$i -ge 0;$i--){Stop-Process -Id $ids[$i] -Force -ErrorAction SilentlyContinue}",
	].join("; ");
	const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		stdio: "ignore",
		timeout: 3000,
		windowsHide: true,
	});
	return !result.error && result.status === 0;
}

export function killProcessTreeSync(pid, platform = process.platform) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	try {
		if (platform === "win32") {
			const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			if (!result.error && result.status === 0) return;
			if (!killOrphanedWindowsTreeSync(pid)) process.kill(pid, "SIGKILL");
		} else {
			process.kill(-pid, "SIGKILL");
		}
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

export async function terminateProcessTree(pid, _signal, platform = process.platform) {
	if (!Number.isInteger(pid) || pid <= 0) return true;
	if (platform === "win32") {
		const taskkillSucceeded = await new Promise((resolve) => {
			let settled = false;
			const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			const finish = (succeeded) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve(succeeded);
			};
			const timeout = setTimeout(() => {
				try {
					killer.kill("SIGKILL");
				} catch {}
				finish(false);
			}, 2500);
			killer.once("error", () => finish(false));
			killer.once("close", (code) => finish(code === 0));
		});
		if (taskkillSucceeded) return !isPidAlive(pid);
		const fallbackSucceeded = killOrphanedWindowsTreeSync(pid);
		return fallbackSucceeded && !isPidAlive(pid);
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	return !isPidAlive(pid);
}

/**
 * Wait for a source-mode CLI child while owning signal forwarding and tree cleanup.
 * Returns an exit code so the launcher can finish naturally instead of calling
 * process.exit() before pending cleanup has settled.
 */
export function superviseChildProcess(
	child,
	{
		host = process,
		terminateTree = terminateProcessTree,
		killTreeSync = killProcessTreeSync,
		forwardSignal = forwardProcessSignal,
		waitForGrace = () => wait(1500),
	} = {},
) {
	return new Promise((resolve) => {
		let finished = false;
		let stopping = false;
		let childExited = false;
		let notifyChildExit;
		const childExit = new Promise((done) => {
			notifyChildExit = done;
		});
		const signals = ["SIGINT", "SIGTERM", "SIGHUP"];

		const removeListeners = () => {
			for (const signal of signals) host.removeListener(signal, signalHandlers[signal]);
			host.removeListener("exit", onHostExit);
			child.removeListener("exit", onChildExit);
			child.removeListener("error", onChildError);
		};
		const finish = (exitCode) => {
			if (finished) return;
			finished = true;
			removeListeners();
			resolve(exitCode);
		};
		const onHostExit = () => {
			if (!finished && child.pid) killTreeSync(child.pid);
		};
		const onChildExit = (code, signal) => {
			childExited = true;
			notifyChildExit();
			if (stopping) return;
			if (signal && child.pid) killTreeSync(child.pid);
			finish(signal ? signalExitCode(signal) : (code ?? 1));
		};
		const onChildError = () => {
			if (!stopping) finish(1);
		};
		const onSignal = async (signal) => {
			if (stopping || finished) return;
			stopping = true;
			try {
				if (child.pid) forwardSignal(child.pid, signal);
				await Promise.race([childExit, waitForGrace()]);
				if (!childExited && child.pid) {
					const cleaned = await terminateTree(child.pid, signal);
					if (cleaned === false) killTreeSync(child.pid);
				}
			} finally {
				finish(signalExitCode(signal));
			}
		};
		const signalHandlers = Object.fromEntries(signals.map((signal) => [signal, () => void onSignal(signal)]));

		for (const signal of signals) host.once(signal, signalHandlers[signal]);
		host.once("exit", onHostExit);
		child.once("exit", onChildExit);
		child.once("error", onChildError);
	});
}
