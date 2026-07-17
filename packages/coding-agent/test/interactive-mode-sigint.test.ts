import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type SignalHandler = (...args: unknown[]) => void;

type RegisterContext = {
	isSuspended: boolean;
	shutdown: () => Promise<void>;
	emergencyTerminalExit: () => void;
	uncaughtCrash: (error: Error) => void;
	showError: (message: string) => void;
	unregisterSignalHandlers: () => void;
	signalCleanupHandlers: Array<() => void>;
};

type InteractiveModePrototypeWithRegister = {
	registerSignalHandlers(this: RegisterContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototypeWithRegister;

/**
 * Invoke the real registerSignalHandlers() against a minimal context while
 * capturing (not actually installing) each prepended process listener, so we
 * can drive the SIGINT handler directly.
 */
function registerAndCapture(context: RegisterContext): Map<string, SignalHandler> {
	const captured = new Map<string, SignalHandler>();
	vi.spyOn(process, "prependListener").mockImplementation(((event: string | symbol, listener: SignalHandler) => {
		captured.set(String(event), listener);
		return process;
	}) as typeof process.prependListener);
	vi.spyOn(process.stdout, "on").mockImplementation((() => process.stdout) as typeof process.stdout.on);
	vi.spyOn(process.stderr, "on").mockImplementation((() => process.stderr) as typeof process.stderr.on);
	interactiveModePrototype.registerSignalHandlers.call(context);
	return captured;
}

function makeContext(overrides: Partial<RegisterContext> = {}): RegisterContext {
	return {
		isSuspended: false,
		shutdown: vi.fn(async () => undefined),
		emergencyTerminalExit: vi.fn(),
		uncaughtCrash: vi.fn(),
		showError: vi.fn(),
		unregisterSignalHandlers: vi.fn(),
		signalCleanupHandlers: [],
		...overrides,
	};
}

describe("InteractiveMode registerSignalHandlers — external SIGINT", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("registers a SIGINT handler in the signals array", () => {
		const context = makeContext();
		const captured = registerAndCapture(context);
		expect(captured.has("SIGINT")).toBe(true);
	});

	test("SIGINT triggers graceful shutdown when not suspended", () => {
		const context = makeContext({ isSuspended: false });
		const captured = registerAndCapture(context);
		const handler = captured.get("SIGINT");
		expect(handler).toBeDefined();
		handler?.();
		expect(context.shutdown).toHaveBeenCalledTimes(1);
	});

	test("SIGINT is a no-op while suspended (Ctrl+Z), letting ignoreSigint win", () => {
		const context = makeContext({ isSuspended: true });
		const captured = registerAndCapture(context);
		const handler = captured.get("SIGINT");
		expect(handler).toBeDefined();
		handler?.();
		expect(context.shutdown).not.toHaveBeenCalled();
	});
});
