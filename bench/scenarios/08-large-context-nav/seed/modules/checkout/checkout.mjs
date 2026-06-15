import { buildCart } from "../cart/cart.mjs";
import { applyDiscount } from "../pricing/discount.mjs";
import { applyTax } from "../pricing/tax.mjs";

export function computeTotal(items, discountPct, taxRate) {
	const cart = buildCart(items);
	const subtotal = cart.reduce((sum, it) => sum + it.price, 0);
	const discounted = applyDiscount(subtotal, discountPct);
	return applyTax(discounted, taxRate);
}
