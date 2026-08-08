import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { MissingSessionCwdError } from "../src/core/session-cwd.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SwitchOptions = Parameters<ExtensionCommandContext["switchSession"]>[1];

interface ResumeSessionHost {
	stopWorkingLoader(): void;
	showStatus(message: string): void;
	ui: { requestRender(force?: boolean): void };
	runtimeHost: {
		switchSession(
			sessionPath: string,
			options?: SwitchOptions & { cwdOverride?: string },
		): Promise<{ cancelled: boolean }>;
	};
	renderCurrentSessionState(): void;
	promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined>;
	handleFatalRuntimeError(message: string, error: unknown): never;
}

const handleResumeSession = (
	InteractiveMode.prototype as unknown as {
		handleResumeSession(
			this: ResumeSessionHost,
			sessionPath: string,
			options?: SwitchOptions,
		): Promise<{ cancelled: boolean }>;
	}
).handleResumeSession;

function createHost(switchSession: ResumeSessionHost["runtimeHost"]["switchSession"]): ResumeSessionHost {
	return {
		stopWorkingLoader: vi.fn(),
		showStatus: vi.fn(),
		ui: { requestRender: vi.fn() },
		runtimeHost: { switchSession },
		renderCurrentSessionState: vi.fn(),
		promptForMissingSessionCwd: vi.fn(async () => undefined),
		handleFatalRuntimeError: (_message, error) => {
			throw error;
		},
	};
}

describe("InteractiveMode session switch options", () => {
	it("forwards options.signal on the normal resume path", async () => {
		const switchSession = vi.fn(async () => ({ cancelled: true }));
		const host = createHost(switchSession);
		const abort = new AbortController();
		const withSession = vi.fn(async () => {});

		await handleResumeSession.call(host, "session.jsonl", { signal: abort.signal, withSession });

		expect(switchSession).toHaveBeenCalledWith("session.jsonl", {
			signal: abort.signal,
			withSession,
		});
	});

	it("forwards options.signal on the missing-cwd retry path", async () => {
		const missingCwd = new MissingSessionCwdError({
			sessionFile: "session.jsonl",
			sessionCwd: "C:\\missing",
			fallbackCwd: "C:\\current",
		});
		const switchSession = vi
			.fn<ResumeSessionHost["runtimeHost"]["switchSession"]>()
			.mockRejectedValueOnce(missingCwd)
			.mockResolvedValueOnce({ cancelled: true });
		const host = createHost(switchSession);
		host.promptForMissingSessionCwd = vi.fn(async () => "C:\\current");
		const abort = new AbortController();
		const withSession = vi.fn(async () => {});

		await handleResumeSession.call(host, "session.jsonl", { signal: abort.signal, withSession });

		expect(switchSession).toHaveBeenNthCalledWith(1, "session.jsonl", {
			signal: abort.signal,
			withSession,
		});
		expect(switchSession).toHaveBeenNthCalledWith(2, "session.jsonl", {
			cwdOverride: "C:\\current",
			signal: abort.signal,
			withSession,
		});
	});
});
