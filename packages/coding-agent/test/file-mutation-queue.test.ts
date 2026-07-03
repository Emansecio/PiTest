import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPreviewQueue, setCurrentPreviewQueue } from "../src/core/preview-queue.js";
import { createEditTool } from "../src/core/tools/edit.js";
import {
	_realpathCacheSizeForTest,
	_resetRealpathCacheForTest,
	withFileMutationQueue,
} from "../src/core/tools/file-mutation-queue.js";
import { createWriteTool } from "../src/core/tools/write.js";

type TextResult = { content: Array<{ type: string; text?: string }> };

function extractPreviewId(result: TextResult): string {
	const text = result.content[0]?.text ?? "";
	const match = text.match(/id=([0-9a-f]+)\./);
	if (!match) throw new Error(`no preview id in: ${text}`);
	return match[1];
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Manual deferred — `Promise.withResolvers` isn't in this project's lib target.
function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-file-mutation-queue-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("withFileMutationQueue", () => {
	it("serializes operations for the same file", async () => {
		const order: string[] = [];
		const path = "/tmp/file-mutation-queue-same";

		const first = withFileMutationQueue(path, async () => {
			order.push("first:start");
			await delay(30);
			order.push("first:end");
		});
		const second = withFileMutationQueue(path, async () => {
			order.push("second:start");
			order.push("second:end");
		});

		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
	});

	it("allows different files to proceed in parallel", async () => {
		const order: string[] = [];

		await Promise.all([
			withFileMutationQueue("/tmp/file-mutation-queue-a", async () => {
				order.push("a:start");
				await delay(30);
				order.push("a:end");
			}),
			withFileMutationQueue("/tmp/file-mutation-queue-b", async () => {
				order.push("b:start");
				await delay(30);
				order.push("b:end");
			}),
		]);

		expect(order.indexOf("a:start")).toBeLessThan(order.indexOf("a:end"));
		expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("b:end"));
		expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("a:end"));
	});

	it("uses the same queue for symlink aliases", async () => {
		const dir = await createTempDir();
		const targetPath = join(dir, "target.txt");
		const symlinkPath = join(dir, "alias.txt");
		await writeFile(targetPath, "hello\n", "utf8");
		await symlink(targetPath, symlinkPath);

		const order: string[] = [];
		await Promise.all([
			withFileMutationQueue(targetPath, async () => {
				order.push("target:start");
				await delay(30);
				order.push("target:end");
			}),
			withFileMutationQueue(symlinkPath, async () => {
				order.push("alias:start");
				order.push("alias:end");
			}),
		]);

		expect(order).toEqual(["target:start", "target:end", "alias:start", "alias:end"]);
	});
});

/**
 * Regression for finding 6.1 in REVISAO-TOOLS-PIT.md: a hung `writeFile` used
 * to leave every later mutation of the same file awaiting forever. The queue
 * now bounds each op with a timeout that both rejects the hung op and releases
 * the slot so subsequent mutations proceed.
 */
describe("withFileMutationQueue timeout", () => {
	it("times out a hung operation and frees the queue for the next op", async () => {
		const path = "/tmp/file-mutation-queue-timeout";
		const hung = withFileMutationQueue(path, () => new Promise<void>(() => {}), 20);
		await expect(hung).rejects.toThrow(/timed out after 20ms/);

		// The slot was released despite the hung op, so a later op still runs.
		let ran = false;
		await withFileMutationQueue(path, async () => {
			ran = true;
		});
		expect(ran).toBe(true);
	});
});

describe("realpath cache is bounded (#17)", () => {
	it("does not grow without limit across many distinct paths", async () => {
		_resetRealpathCacheForTest();
		// Touch far more distinct (non-existent) paths than the cache cap.
		for (let i = 0; i < 5000; i++) {
			await withFileMutationQueue(`/tmp/pi-mutation-cap-${i}.txt`, async () => {});
		}
		// The cache must have evicted down to its bound, not retained all 5000.
		expect(_realpathCacheSizeForTest()).toBeLessThanOrEqual(2048);
		_resetRealpathCacheForTest();
	});
});

describe("built-in edit and write tools", () => {
	it("preserves both parallel edits on the same file", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "parallel-edit.txt");
		await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");

		const editTool = createEditTool(dir, {
			operations: {
				access,
				readFile: async (path) => {
					const buffer = await readFile(path);
					await delay(30);
					return buffer;
				},
				writeFile: async (path, content) => {
					await delay(30);
					await writeFile(path, content, "utf8");
				},
			},
		});

		await Promise.all([
			editTool.execute("call-1", { path: filePath, edits: [{ oldText: "alpha", newText: "ALPHA" }] }),
			editTool.execute("call-2", { path: filePath, edits: [{ oldText: "beta", newText: "BETA" }] }),
		]);

		const content = await readFile(filePath, "utf8");
		expect(content).toBe("ALPHA\nBETA\ngamma\n");
	});

	it("shares the queue between edit and write", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "mixed.txt");
		await writeFile(filePath, "original\n", "utf8");

		const editTool = createEditTool(dir, {
			operations: {
				access,
				readFile: async (path) => {
					const buffer = await readFile(path);
					await delay(30);
					return buffer;
				},
				writeFile: async (path, content) => {
					await delay(30);
					await writeFile(path, content, "utf8");
				},
			},
		});
		const writeTool = createWriteTool(dir, {
			operations: {
				mkdir: async () => {},
				writeFile: async (path, content) => {
					await delay(10);
					await writeFile(path, content, "utf8");
				},
			},
		});

		const editPromise = editTool.execute("call-1", {
			path: filePath,
			edits: [{ oldText: "original", newText: "edited" }],
		});
		await delay(5);
		const writePromise = writeTool.execute("call-2", {
			path: filePath,
			content: "replacement\n",
		});

		await Promise.all([editPromise, writePromise]);

		const content = await readFile(filePath, "utf8");
		expect(content).toBe("replacement\n");
	});
});

/**
 * Regression for finding 6.1 in REVISAO-TOOLS-PIT.md: preview-apply closures
 * computed `finalContent` at staging time but blindly overwrote whatever was
 * on disk at commit time. Both `edit` and `write` now snapshot the mtime at
 * staging and refuse to apply if the file drifted before commit.
 */
describe("preview apply() staleness re-check", () => {
	it("write's apply throws instead of blindly overwriting when the file changed after staging", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "drift-write.txt");
		await writeFile(filePath, "original\n", "utf8");

		const writeTool = createWriteTool(dir);
		const queue = createPreviewQueue();
		setCurrentPreviewQueue(queue);
		try {
			const staged = (await writeTool.execute("w1", {
				path: filePath,
				content: "replacement\n",
				preview: true,
			})) as TextResult;
			const id = extractPreviewId(staged);

			// External change lands on disk after staging, before commit. A
			// genuine wall-clock gap is required here (not a mock): the staleness
			// check is defined in terms of the real filesystem's mtime, and two
			// back-to-back writes can otherwise land within the same mtime tick.
			await delay(20);
			await writeFile(filePath, "externally-changed\n", "utf8");

			const outcome = await queue.accept(id);
			expect(outcome.ok).toBe(false);
			if (!outcome.ok) {
				expect(outcome.error).toMatch(/changed on disk since this write was staged/);
			}
			expect(await readFile(filePath, "utf8")).toBe("externally-changed\n");
		} finally {
			setCurrentPreviewQueue(undefined);
		}
	});

	it("edit's apply throws instead of blindly overwriting when the file changed after staging", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "drift-edit.txt");
		await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");

		const editTool = createEditTool(dir);
		const queue = createPreviewQueue();
		setCurrentPreviewQueue(queue);
		try {
			const staged = (await editTool.execute("e1", {
				path: filePath,
				edits: [{ oldText: "beta", newText: "BETA" }],
				preview: true,
			})) as TextResult;
			const id = extractPreviewId(staged);

			await delay(20);
			await writeFile(filePath, "alpha\nbeta\ngamma\nexternal\n", "utf8");

			const outcome = await queue.accept(id);
			expect(outcome.ok).toBe(false);
			if (!outcome.ok) {
				expect(outcome.error).toMatch(/changed on disk since this edit was staged/);
			}
			expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\ngamma\nexternal\n");
		} finally {
			setCurrentPreviewQueue(undefined);
		}
	});
});

describe("preview apply() routes through the mutation queue", () => {
	it("serializes two staged write applies targeting the same file", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "serialized-write.txt");
		await writeFile(filePath, "seed\n", "utf8");

		const order: string[] = [];
		const started1 = deferred<void>();
		const gate1 = deferred<void>();

		const writeTool = createWriteTool(dir, {
			operations: {
				mkdir: async () => {},
				writeFile: async (path, content) => {
					const label = content.trim();
					order.push(`start:${label}`);
					if (label === "first") {
						started1.resolve();
						await gate1.promise;
					}
					await writeFile(path, content, "utf8");
					order.push(`end:${label}`);
				},
			},
		});

		const queue = createPreviewQueue();
		setCurrentPreviewQueue(queue);
		try {
			const first = (await writeTool.execute("w1", {
				path: filePath,
				content: "first\n",
				preview: true,
			})) as TextResult;
			const second = (await writeTool.execute("w2", {
				path: filePath,
				content: "second\n",
				preview: true,
			})) as TextResult;
			const firstId = extractPreviewId(first);
			const secondId = extractPreviewId(second);

			const firstApplyPromise = queue.accept(firstId);
			await started1.promise;
			const secondApplyPromise = queue.accept(secondId);

			// "second" targets the same mutation-queue key as "first", so its
			// writeFile must not run until "first"'s apply settles — even though
			// accept() has already been called for it above.
			expect(order).toEqual(["start:first"]);

			gate1.resolve();
			await Promise.all([firstApplyPromise, secondApplyPromise]);

			expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
		} finally {
			setCurrentPreviewQueue(undefined);
		}
	});
});
