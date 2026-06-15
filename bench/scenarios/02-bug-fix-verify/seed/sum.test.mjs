import { sumArray } from "./sum.mjs";

function assert(cond, msg) {
	if (!cond) {
		console.log(`FAIL: ${msg}`);
		process.exit(1);
	}
}

assert(sumArray([1, 2, 3]) === 6, "sum([1,2,3]) should be 6");
assert(sumArray([10]) === 10, "sum([10]) should be 10");
assert(sumArray([]) === 0, "sum([]) should be 0");
assert(sumArray([5, 5, 5, 5]) === 20, "sum([5,5,5,5]) should be 20");
console.log("OK");
