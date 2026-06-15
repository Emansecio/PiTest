import { isValidEmail } from "./validate.mjs";

function assert(cond, msg) {
	if (!cond) {
		console.log(`FAIL: ${msg}`);
		process.exit(1);
	}
}

assert(isValidEmail("a@b.com") === true, '"a@b.com" should be valid');
assert(isValidEmail("x@y.org") === true, '"x@y.org" should be valid');
assert(isValidEmail("no-at-sign") === false, '"no-at-sign" should be invalid');
assert(isValidEmail("missing@dot") === false, '"missing@dot" should be invalid');
assert(isValidEmail("") === false, '"" should be invalid');
console.log("OK");
