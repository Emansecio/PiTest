import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	__resetClaudeCodeVersionCacheForTests,
	type ClaudeCodeVersionDeps,
	ensureClaudeCodeVersionEnv,
	gateModelRequestsOnClaudeCodeVersion,
	type ResolvedClaudeBinary,
} from "../src/core/claude-code-version.js";

describe("ensureClaudeCodeVersionEnv", () => {
	const ENV = "PIT_CLAUDE_CODE_VERSION";
	const NO_CACHE_ENV = "PIT_NO_CLAUDE_VERSION_CACHE";
	let originalEnv: string | undefined;
	let originalNoCache: string | undefined;
	let tempDir: string;

	const restore = (name: string, value: string | undefined): void => {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	};

	beforeEach(() => {
		originalEnv = process.env[ENV];
		originalNoCache = process.env[NO_CACHE_ENV];
		delete process.env[ENV];
		delete process.env[NO_CACHE_ENV];
		__resetClaudeCodeVersionCacheForTests();
		tempDir = mkdtempSync(join(tmpdir(), "pit-claude-version-"));
	});

	afterEach(() => {
		restore(ENV, originalEnv);
		restore(NO_CACHE_ENV, originalNoCache);
		__resetClaudeCodeVersionCacheForTests();
		rmSync(tempDir, { recursive: true, force: true });
	});

	const binary: ResolvedClaudeBinary = { path: "C:\\bin\\claude.cmd", mtimeMs: 111.5, size: 42 };

	function deps(overrides: Partial<ClaudeCodeVersionDeps> = {}): ClaudeCodeVersionDeps {
		return {
			resolveBinary: async () => undefined,
			runVersionCommand: async () => undefined,
			cacheFilePath: join(tempDir, "claude-code-version.json"),
			...overrides,
		};
	}

	it("sets the env var from the detected version when unset", async () => {
		await ensureClaudeCodeVersionEnv(deps({ runVersionCommand: async () => "2.1.170 (Claude Code)" }));
		expect(process.env[ENV]).toBe("2.1.170");
	});

	it("does not overwrite an explicit override and skips detection entirely", async () => {
		process.env[ENV] = "9.9.9";
		let spawns = 0;
		await ensureClaudeCodeVersionEnv(
			deps({
				runVersionCommand: async () => {
					spawns++;
					return "2.1.170 (Claude Code)";
				},
			}),
		);
		expect(process.env[ENV]).toBe("9.9.9");
		expect(spawns).toBe(0);
	});

	it("tries claude-code after claude fails, in order", async () => {
		const commands: string[] = [];
		await ensureClaudeCodeVersionEnv(
			deps({
				runVersionCommand: async (command) => {
					commands.push(command);
					return command === "claude-code" ? "1.2.3 (Claude Code)" : undefined;
				},
			}),
		);
		expect(commands).toEqual(["claude", "claude-code"]);
		expect(process.env[ENV]).toBe("1.2.3");
	});

	it("leaves the env unset when detection fails", async () => {
		await ensureClaudeCodeVersionEnv(deps());
		expect(process.env[ENV]).toBeUndefined();
	});

	it("leaves the env unset on unparseable output", async () => {
		await ensureClaudeCodeVersionEnv(deps({ runVersionCommand: async () => "not a version" }));
		expect(process.env[ENV]).toBeUndefined();
	});

	it("never rejects even when the injected seams throw", async () => {
		await expect(
			ensureClaudeCodeVersionEnv(
				deps({
					resolveBinary: async () => {
						throw new Error("boom");
					},
					runVersionCommand: async () => {
						throw new Error("boom");
					},
				}),
			),
		).resolves.toBeUndefined();
		expect(process.env[ENV]).toBeUndefined();
	});

	it("caches the detected version on disk and skips the spawn on a hit", async () => {
		let spawns = 0;
		const spawning = deps({
			resolveBinary: async () => binary,
			runVersionCommand: async () => {
				spawns++;
				return "3.0.1 (Claude Code)";
			},
		});
		await ensureClaudeCodeVersionEnv(spawning);
		expect(process.env[ENV]).toBe("3.0.1");
		expect(spawns).toBe(1);
		expect(existsSync(spawning.cacheFilePath!)).toBe(true);

		// Fresh boot: same binary identity → cache hit, no spawn.
		delete process.env[ENV];
		__resetClaudeCodeVersionCacheForTests();
		await ensureClaudeCodeVersionEnv(spawning);
		expect(process.env[ENV]).toBe("3.0.1");
		expect(spawns).toBe(1);
	});

	it("invalidates the disk cache when the binary mtime changes", async () => {
		await ensureClaudeCodeVersionEnv(
			deps({
				resolveBinary: async () => binary,
				runVersionCommand: async () => "3.0.1 (Claude Code)",
			}),
		);
		expect(process.env[ENV]).toBe("3.0.1");

		// Fresh boot after a CLI update (new mtime): must re-detect, not reuse.
		delete process.env[ENV];
		__resetClaudeCodeVersionCacheForTests();
		let spawns = 0;
		await ensureClaudeCodeVersionEnv(
			deps({
				resolveBinary: async () => ({ ...binary, mtimeMs: 222 }),
				runVersionCommand: async () => {
					spawns++;
					return "3.0.2 (Claude Code)";
				},
			}),
		);
		expect(spawns).toBe(1);
		expect(process.env[ENV]).toBe("3.0.2");
	});

	it("PIT_NO_CLAUDE_VERSION_CACHE=1 disables cache read and write", async () => {
		process.env[NO_CACHE_ENV] = "1";
		const shared = deps({
			resolveBinary: async () => binary,
			runVersionCommand: async () => "3.0.1 (Claude Code)",
		});
		await ensureClaudeCodeVersionEnv(shared);
		expect(process.env[ENV]).toBe("3.0.1");
		expect(existsSync(shared.cacheFilePath!)).toBe(false);
	});

	it("is single-flight: concurrent calls share one probe", async () => {
		let spawns = 0;
		const slow = deps({
			runVersionCommand: async () => {
				spawns++;
				await new Promise((resolve) => setTimeout(resolve, 10));
				return "2.1.170 (Claude Code)";
			},
		});
		await Promise.all([ensureClaudeCodeVersionEnv(slow), ensureClaudeCodeVersionEnv(slow)]);
		expect(spawns).toBe(1);
		expect(process.env[ENV]).toBe("2.1.170");
	});

	describe("gateModelRequestsOnClaudeCodeVersion", () => {
		/** Stand-in for ModelRegistry: only the auth-resolution seam matters here. */
		function fakeRegistry(onResolve: () => void) {
			return {
				calls: [] as string[],
				async getApiKeyAndHeaders(model: { id: string }) {
					onResolve();
					this.calls.push(model.id);
					return { ok: true as const, apiKey: "k", version: process.env[ENV] };
				},
			};
		}

		it("holds the first model request until the probe settles, without blocking the caller before that", async () => {
			let releaseProbe: () => void = () => {};
			const probeDone = new Promise<void>((resolve) => {
				releaseProbe = resolve;
			});
			const ready = probeDone.then(() => {
				process.env[ENV] = "4.5.6";
			});

			let resolvedAuth = false;
			const registry = fakeRegistry(() => {
				resolvedAuth = true;
			});
			gateModelRequestsOnClaudeCodeVersion(registry, ready);

			// A request issued while the probe is in flight must not resolve auth yet
			// (the UI, which never touches this seam, is free to paint meanwhile).
			const pending = registry.getApiKeyAndHeaders({ id: "opus" });
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(resolvedAuth).toBe(false);

			releaseProbe();
			const auth = await pending;
			expect(auth.version).toBe("4.5.6");
			expect(registry.calls).toEqual(["opus"]);
		});

		it("passes through once the probe has settled and is idempotent", async () => {
			const ready = Promise.resolve();
			const registry = fakeRegistry(() => {});
			gateModelRequestsOnClaudeCodeVersion(registry, ready);
			const wrapped = registry.getApiKeyAndHeaders;
			// Double install (e.g. a runtime rebuilt on /new) must not stack wrappers.
			gateModelRequestsOnClaudeCodeVersion(registry, ready);
			expect(registry.getApiKeyAndHeaders).toBe(wrapped);

			await expect(registry.getApiKeyAndHeaders({ id: "sonnet" })).resolves.toMatchObject({ ok: true, apiKey: "k" });
			expect(registry.calls).toEqual(["sonnet"]);
		});

		it("still resolves requests when detection found nothing (static fallback stays)", async () => {
			const registry = fakeRegistry(() => {});
			// ensureClaudeCodeVersionEnv never rejects; a failed probe just leaves the env unset.
			gateModelRequestsOnClaudeCodeVersion(registry, ensureClaudeCodeVersionEnv(deps()));
			const auth = await registry.getApiKeyAndHeaders({ id: "haiku" });
			expect(auth.ok).toBe(true);
			expect(auth.version).toBeUndefined();
		});
	});
});
