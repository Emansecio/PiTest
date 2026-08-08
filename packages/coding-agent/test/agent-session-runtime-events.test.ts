import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type {
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../src/index.js";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime session lifecycle events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost(extensionFactory: ExtensionFactory) {
		const tempDir = join(tmpdir(), `pi-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			// Lifecycle-event tests don't touch LSP or frequent-files; disabling both skips
			// the LSP manager warmup and per-boot `git` frequent-files scan on every session.
			settingsManager: SettingsManager.inMemory({ lsp: { enabled: false }, frequentFiles: { enabled: false } }),
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, faux };
	}

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;
		expect(originalSessionFile).toBeTruthy();

		const newSessionResult = await runtimeHost.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		const secondSessionFile = runtimeHost.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;
		expect(secondSessionFile).toBeTruthy();

		const switchResult = await runtimeHost.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				return { cancel: true };
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;

		const result = await runtimeHost.newSession();
		expect(result.cancelled).toBe(true);
		expect(runtimeHost.session.sessionFile).toBe(originalSessionFile);
		expect(events).toEqual([{ type: "session_before_switch", reason: "new", targetSessionFile: undefined }]);
	});

	it("pre-aborted switch invokes no session_before_switch handlers", async () => {
		let handlerCalls = 0;
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", () => {
				handlerCalls++;
				return { cancel: true };
			});
		});
		const abort = new AbortController();
		abort.abort(new Error("switch cancelled"));

		const result = await runtimeHost.switchSession("unused-session.jsonl", { signal: abort.signal });

		expect(result).toEqual({ cancelled: true });
		expect(handlerCalls).toBe(0);
	});

	it("abort during session_before_switch prevents later handlers and cancels replacement", async () => {
		const previousTimeout = process.env.PIT_EXTENSION_HOOK_TIMEOUT_MS;
		process.env.PIT_EXTENSION_HOOK_TIMEOUT_MS = "80";
		try {
			const abort = new AbortController();
			const handlerOrder: string[] = [];
			const { runtimeHost } = await createRuntimeHost((pi) => {
				pi.on("session_before_switch", async () => {
					handlerOrder.push("first");
					abort.abort(new Error("switch cancelled"));
					await new Promise(() => {});
				});
				pi.on("session_before_switch", () => {
					handlerOrder.push("second");
				});
			});
			const oldSession = runtimeHost.session;
			const errors: string[] = [];
			oldSession.extensionRunner.onError((error) => errors.push(error.error));

			const result = await runtimeHost.newSession({ signal: abort.signal });

			expect(result).toEqual({ cancelled: true });
			expect(runtimeHost.session).toBe(oldSession);
			expect(handlerOrder).toEqual(["first"]);
			expect(errors).toEqual([]);
		} finally {
			if (previousTimeout === undefined) delete process.env.PIT_EXTENSION_HOOK_TIMEOUT_MS;
			else process.env.PIT_EXTENSION_HOOK_TIMEOUT_MS = previousTimeout;
		}
	});

	it("times out a never-settling session_before_switch handler and continues replacement", async () => {
		const previousTimeout = process.env.PIT_SESSION_BEFORE_HOOK_TIMEOUT_MS;
		process.env.PIT_SESSION_BEFORE_HOOK_TIMEOUT_MS = "80";
		try {
			const handlerOrder: string[] = [];
			const { runtimeHost } = await createRuntimeHost((pi) => {
				pi.on("session_before_switch", async () => {
					handlerOrder.push("hung");
					await new Promise(() => {});
				});
				pi.on("session_before_switch", () => {
					handlerOrder.push("next");
				});
			});
			const oldSession = runtimeHost.session;
			const errors: Array<{ event: string; error: string }> = [];
			oldSession.extensionRunner.onError((error) => {
				errors.push({ event: error.event, error: error.error });
			});

			const start = Date.now();
			const result = await Promise.race([
				runtimeHost.newSession(),
				new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
			]);

			expect(result).toBeDefined();
			if (!result) return;
			expect(Date.now() - start).toBeLessThan(2000);
			expect(result.cancelled).toBe(false);
			expect(runtimeHost.session).not.toBe(oldSession);
			expect(handlerOrder).toEqual(["hung", "next"]);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatchObject({ event: "session_before_switch" });
			expect(errors[0]?.error).toMatch(/timed out.*80ms/i);
		} finally {
			if (previousTimeout === undefined) delete process.env.PIT_SESSION_BEFORE_HOOK_TIMEOUT_MS;
			else process.env.PIT_SESSION_BEFORE_HOOK_TIMEOUT_MS = previousTimeout;
		}
	});

	it("does not apply the before_agent_start timeout to session_before handlers", async () => {
		const previousExtensionTimeout = process.env.PIT_EXTENSION_HOOK_TIMEOUT_MS;
		const previousSessionTimeout = process.env.PIT_SESSION_BEFORE_HOOK_TIMEOUT_MS;
		process.env.PIT_EXTENSION_HOOK_TIMEOUT_MS = "20";
		process.env.PIT_SESSION_BEFORE_HOOK_TIMEOUT_MS = "500";
		try {
			const { runtimeHost } = await createRuntimeHost((pi) => {
				pi.on("session_before_switch", async () => {
					await new Promise((resolve) => setTimeout(resolve, 60));
				});
			});
			const errors: string[] = [];
			runtimeHost.session.extensionRunner.onError((error) => errors.push(error.error));

			const result = await runtimeHost.newSession();

			expect(result.cancelled).toBe(false);
			expect(errors).toEqual([]);
		} finally {
			if (previousExtensionTimeout === undefined) delete process.env.PIT_EXTENSION_HOOK_TIMEOUT_MS;
			else process.env.PIT_EXTENSION_HOOK_TIMEOUT_MS = previousExtensionTimeout;
			if (previousSessionTimeout === undefined) delete process.env.PIT_SESSION_BEFORE_HOOK_TIMEOUT_MS;
			else process.env.PIT_SESSION_BEFORE_HOOK_TIMEOUT_MS = previousSessionTimeout;
		}
	});

	it("wires and awaits idempotent coordinator cleanup during direct dispose", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		expect(typeof runtimeHost.session._disposeCoordinator).toBe("function");
		let releaseCleanup!: () => void;
		const cleanupGate = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		const disposeCoordinator = vi.fn(async () => cleanupGate);
		runtimeHost.session._disposeCoordinator = disposeCoordinator;

		const pending = runtimeHost.session.dispose();
		const settledEarly = await Promise.race([
			pending.then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 30)),
		]);
		expect(settledEarly).toBe(false);
		releaseCleanup();
		await Promise.all([pending, runtimeHost.session.dispose()]);
		expect(disposeCoordinator).toHaveBeenCalledTimes(1);
	});

	it("direct dispose aborts the registered coordinator callback once before waiting for principal idle", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const phases: string[] = [];
		let releaseIdle!: () => void;
		const idle = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		runtimeHost.session._abortDetachedSubagents = () => {
			phases.push("coordinator-abort");
		};
		vi.spyOn(runtimeHost.session.agent, "waitForIdle").mockImplementation(async () => {
			phases.push("principal-idle");
			await idle;
		});

		const firstDispose = runtimeHost.session.dispose();
		const secondDispose = runtimeHost.session.dispose();
		const phasesBeforeIdleSettled = [...phases];
		releaseIdle();
		await Promise.all([firstDispose, secondDispose]);
		await runtimeHost.dispose();

		expect(phasesBeforeIdleSettled).toEqual(["coordinator-abort", "principal-idle"]);
		expect(phases.filter((phase) => phase === "coordinator-abort")).toHaveLength(1);
	});

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		const previousSessionFile = runtimeHost.session.sessionFile;

		const successResult = await runtimeHost.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtimeHost.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtimeHost.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtimeHost.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});
});
