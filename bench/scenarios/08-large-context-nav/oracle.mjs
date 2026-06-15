import { check, importSandbox, pass, runNode, unchanged } from "../_helpers.mjs";

check(unchanged("test.mjs"), "test.mjs foi modificado — não podia ser tocado");
const t = runNode("test.mjs");
check(t.code === 0, `test.mjs ainda falha: ${t.out.trim().split("\n").pop()}`);
// held-out: confirma que o desconto virou percentual de verdade (não absoluto)
const { computeTotal } = await importSandbox("modules/checkout/checkout.mjs");
check(computeTotal([{ price: 50 }], 20, 0) === 40, `held-out: 50 com 20% deveria ser 40, veio ${computeTotal([{ price: 50 }], 20, 0)}`);
check(computeTotal([{ price: 200 }], 10, 0) === 180, `held-out: 200 com 10% deveria ser 180, veio ${computeTotal([{ price: 200 }], 10, 0)}`);
pass("bug de desconto corrigido na árvore, testes passam");
