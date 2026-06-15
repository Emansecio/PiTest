export function buildCart(items) {
	return items.map((it) => ({ ...it }));
}
