import { afterEach, describe, expect, it } from "vitest";
import {
	createDeferredOutputStore,
	getCurrentDeferredOutputStore,
	setCurrentDeferredOutputStore,
} from "../src/core/deferred-output-store.js";

afterEach(() => {
	setCurrentDeferredOutputStore(undefined);
});

describe("DeferredOutputStore", () => {
	it("put→get round-trip returns the original content", () => {
		const store = createDeferredOutputStore();
		const content = "hello world\nsome tool output";
		const id = store.put(content);
		expect(id).toMatch(/^d\d+$/);
		expect(store.get(id)).toBe(content);
		store.dispose();
	});

	it("sequential puts produce distinct ids and each round-trips", () => {
		const store = createDeferredOutputStore();
		const id1 = store.put("first");
		const id2 = store.put("second");
		expect(id1).not.toBe(id2);
		expect(store.get(id1)).toBe("first");
		expect(store.get(id2)).toBe("second");
		store.dispose();
	});

	it("get of unknown id returns undefined", () => {
		const store = createDeferredOutputStore();
		expect(store.get("d999")).toBeUndefined();
		store.dispose();
	});

	it("get of malformed id (path traversal) returns undefined", () => {
		const store = createDeferredOutputStore();
		expect(store.get("../x")).toBeUndefined();
		expect(store.get("d1/../../etc/passwd")).toBeUndefined();
		expect(store.get("")).toBeUndefined();
		store.dispose();
	});

	it("dispose removes the temp dir; subsequent get does not throw", () => {
		const store = createDeferredOutputStore();
		const id = store.put("data");
		store.dispose();
		// After dispose, get should return undefined or not throw.
		let threw = false;
		let result: string | undefined;
		try {
			result = store.get(id);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBeUndefined();
	});

	it("module-level registry roundtrip", () => {
		expect(getCurrentDeferredOutputStore()).toBeUndefined();
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		expect(getCurrentDeferredOutputStore()).toBe(store);
		setCurrentDeferredOutputStore(undefined);
		expect(getCurrentDeferredOutputStore()).toBeUndefined();
		store.dispose();
	});
});
