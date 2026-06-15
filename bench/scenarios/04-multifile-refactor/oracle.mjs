import { readdirSync } from "node:fs";
import { check, pass, readSandbox, runNode, SANDBOX } from "../_helpers.mjs";

// 1) nenhum vestígio do nome antigo em qualquer .mjs
const files = readdirSync(SANDBOX).filter((f) => f.endsWith(".mjs"));
for (const f of files) {
	check(!readSandbox(f).includes("getUserName"), `${f} ainda contém "getUserName"`);
}

// 2) o nome novo aparece na definição e nos call sites
check(readSandbox("user.mjs").includes("resolveDisplayName"), "user.mjs não define resolveDisplayName");
for (const f of ["a.mjs", "b.mjs", "c.mjs"]) {
	check(readSandbox(f).includes("resolveDisplayName"), `${f} não usa resolveDisplayName`);
}

// 3) comportamento idêntico
const r = runNode("main.mjs");
check(r.code === 0, `main.mjs quebrou: ${r.out.trim()}`);
const expected = "Hi Ada Lovelace\nHello Ada Lovelace\nADA LOVELACE";
const got = r.out.trim().replace(/\r/g, "");
check(got === expected, `saída mudou:\n--- esperado ---\n${expected}\n--- veio ---\n${got}`);
pass("símbolo renomeado em todos os arquivos, comportamento idêntico");
