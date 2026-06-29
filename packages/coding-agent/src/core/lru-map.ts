/** Insertion-ordered Map with a hard entry cap; get/set refresh recency. */
export class LruMap<K, V> {
	private readonly map = new Map<K, V>();
	private readonly max: number;

	constructor(max: number) {
		this.max = Math.max(1, max);
	}

	get(key: K): V | undefined {
		const value = this.map.get(key);
		if (value === undefined) return undefined;
		this.map.delete(key);
		this.map.set(key, value);
		return value;
	}

	has(key: K): boolean {
		return this.map.has(key);
	}

	set(key: K, value: V): void {
		if (this.map.has(key)) {
			this.map.delete(key);
		}
		this.map.set(key, value);
		while (this.map.size > this.max) {
			const oldest = this.map.keys().next().value;
			if (oldest === undefined) break;
			this.map.delete(oldest);
		}
	}

	delete(key: K): boolean {
		return this.map.delete(key);
	}

	clear(): void {
		this.map.clear();
	}

	get size(): number {
		return this.map.size;
	}
}
