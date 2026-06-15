import { check, importSandbox, pass, runNode, unchanged } from "../_helpers.mjs";

check(unchanged("accept.test.mjs"), "accept.test.mjs foi modificado — não podia ser tocado");
const t = runNode("accept.test.mjs");
check(t.code === 0, `aceite falha: ${t.out.trim().split("\n").pop()}`);
// held-out: casos fora da bateria visível
const { slugify } = await importSandbox("cli.mjs");
const cases = [
	["Hello___World!!!", "hello-world"],
	["  A B  ", "a-b"],
	["Trailing!!!", "trailing"],
	["123 abc", "123-abc"],
	["@@@", ""],
];
for (const [inp, want] of cases) {
	const got = slugify(inp);
	check(got === want, `held-out slugify(${JSON.stringify(inp)}) deveria ser ${JSON.stringify(want)}, veio ${JSON.stringify(got)}`);
}
pass("slugify implementado conforme spec, testes intactos");
