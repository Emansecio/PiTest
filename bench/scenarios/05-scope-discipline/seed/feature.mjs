// Parses a money amount string like "12.50" into integer cents.
export function parseAmount(str) {
	const value = Math.round(parseFloat(str) * 100);
	return value;
}
