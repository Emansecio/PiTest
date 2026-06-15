import { fail, pass, readSandbox } from "../_helpers.mjs";

let raw;
try {
	raw = readSandbox("count.txt");
} catch {
	fail("count.txt não foi criado na raiz do projeto");
}
const n = Number.parseInt(raw.trim(), 10);
if (Number.isNaN(n)) fail(`count.txt não contém um número: ${JSON.stringify(raw)}`);
if (n !== 7) fail(`contagem errada: count.txt=${n}, esperado 7 (.mjs no topo de src/)`);
pass("count.txt = 7");
