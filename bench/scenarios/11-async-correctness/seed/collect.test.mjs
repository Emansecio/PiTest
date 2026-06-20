import assert from "node:assert";
import { collect } from "./collect.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const out = await collect([1, 2, 3, 4], async (x) => {
	await delay(1);
	return x * 10;
});
assert.deepStrictEqual(out, [10, 20, 30, 40], `collect deveria devolver [10,20,30,40], veio ${JSON.stringify(out)}`);
console.log("ok");
