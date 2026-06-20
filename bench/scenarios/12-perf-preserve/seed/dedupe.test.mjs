import assert from "node:assert";
import { dedupe } from "./dedupe.mjs";

assert.deepStrictEqual(dedupe([1, 2, 2, 3, 1]), [1, 2, 3]);
assert.deepStrictEqual(dedupe(["a", "b", "a", "c"]), ["a", "b", "c"]);
assert.deepStrictEqual(dedupe([]), []);
assert.deepStrictEqual(dedupe([7, 7, 7]), [7]);
console.log("ok");
