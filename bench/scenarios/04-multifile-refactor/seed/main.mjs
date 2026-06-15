import { greetA } from "./a.mjs";
import { greetB } from "./b.mjs";
import { labelC } from "./c.mjs";

const u = { first: "Ada", last: "Lovelace" };
console.log(greetA(u));
console.log(greetB(u));
console.log(labelC(u));
