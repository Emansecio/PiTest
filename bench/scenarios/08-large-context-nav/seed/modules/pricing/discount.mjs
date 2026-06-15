// Applies a percentage discount to a total.
export function applyDiscount(total, pct) {
	// BUG: subtracts pct as an absolute amount instead of a percentage.
	return total - pct;
}
