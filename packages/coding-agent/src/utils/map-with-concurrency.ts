/**
 * Run `fn` over `items` with at most `limit` concurrent in-flight promises.
 * Results preserve input order.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = Math.min(Math.max(1, limit), items.length);
	if (items.length === 0) return out;
	await Promise.all(
		Array.from({ length: workers }, async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) break;
				out[i] = await fn(items[i]!, i);
			}
		}),
	);
	return out;
}
