// Applies a percentage tax rate to a total.
export function applyTax(total, rate) {
	return total * (1 + rate / 100);
}
