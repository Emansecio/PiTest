import { fizzbuzz } from "./fizzbuzz.mjs";

function eq(got, want) {
	if (got !== want) {
		console.log(`FAIL: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
		process.exit(1);
	}
}

eq(fizzbuzz(1), "1");
eq(fizzbuzz(2), "2");
eq(fizzbuzz(3), "Fizz");
eq(fizzbuzz(5), "Buzz");
eq(fizzbuzz(6), "Fizz");
eq(fizzbuzz(10), "Buzz");
eq(fizzbuzz(15), "FizzBuzz");
eq(fizzbuzz(30), "FizzBuzz");
console.log("OK");
