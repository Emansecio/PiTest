// Prints the total price of all items in the cart.
const cart = {
	items: [
		{ name: "apple", price: 3 },
		{ name: "bread", price: 5 },
		{ name: "milk", price: 4 },
	],
};

function total(c) {
	return c.item.reduce((sum, it) => sum + it.price, 0);
}

console.log(`TOTAL=${total(cart)}`);
