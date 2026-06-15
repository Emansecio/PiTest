import { computeTotal } from "./modules/checkout/checkout.mjs";

function eq(got, want, msg) {
	if (got !== want) {
		console.log(`FAIL: ${msg} — expected ${want}, got ${got}`);
		process.exit(1);
	}
}

eq(computeTotal([{ price: 100 }, { price: 100 }], 10, 0), 180, "200 com 10% de desconto");
eq(computeTotal([{ price: 50 }, { price: 30 }], 0, 10), 88, "80 com 10% de imposto");
eq(computeTotal([{ price: 60 }, { price: 60 }], 50, 0), 60, "120 com 50% de desconto");
console.log("OK");
