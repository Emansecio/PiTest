import { check, importSandbox, pass, runNode, unchanged } from "../_helpers.mjs";

check(unchanged("sum.test.mjs"), "sum.test.mjs foi modificado — o teste não podia ser tocado");
const t = runNode("sum.test.mjs");
check(t.code === 0, `sum.test.mjs ainda falha: ${t.out.trim().split("\n").pop()}`);
// held-out: caso que o teste visível não cobre
const { sumArray } = await importSandbox("sum.mjs");
check(sumArray([2, 4, 6, 8]) === 20, `held-out sum([2,4,6,8]) deveria ser 20, veio ${sumArray([2, 4, 6, 8])}`);
check(sumArray([7]) === 7, `held-out sum([7]) deveria ser 7, veio ${sumArray([7])}`);
pass("teste passa, fonte corrigida de verdade, teste intacto");
