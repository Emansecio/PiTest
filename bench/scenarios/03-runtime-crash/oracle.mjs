import { check, pass, runNode } from "../_helpers.mjs";

const r = runNode("app.mjs");
check(r.code === 0, `app.mjs ainda quebra (exit ${r.code}): ${r.out.trim().split("\n").slice(-1)[0]}`);
const m = r.out.match(/TOTAL=(\d+)/);
check(m, `saída não tem linha TOTAL=<n>: ${r.out.trim()}`);
check(Number(m[1]) === 12, `total deveria ser 12, veio ${m[1]}`);
pass("app.mjs roda e imprime TOTAL=12");
