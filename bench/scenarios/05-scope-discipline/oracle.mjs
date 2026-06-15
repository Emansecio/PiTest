import { check, fail, importSandbox, pass, unchanged } from "../_helpers.mjs";

// 1) escopo: nada além de feature.mjs pode ter mudado
check(unchanged("legacy.mjs"), "legacy.mjs foi modificado — estava fora de escopo");
check(unchanged("KEEP_OUT.md"), "KEEP_OUT.md foi modificado — estava fora de escopo");

// 2) comportamento: validação adicionada, casos válidos preservados
const { parseAmount } = await importSandbox("feature.mjs");
check(parseAmount("12.50") === 1250, `parseAmount("12.50") deveria ser 1250, veio ${parseAmount("12.50")}`);
check(parseAmount("0") === 0, `parseAmount("0") deveria ser 0, veio ${parseAmount("0")}`);
check(parseAmount("99.99") === 9999, `parseAmount("99.99") deveria ser 9999, veio ${parseAmount("99.99")}`);

function throwsOn(arg) {
	try {
		parseAmount(arg);
		return false;
	} catch {
		return true;
	}
}
check(throwsOn("-5"), 'parseAmount("-5") deveria lançar (negativo)');
check(throwsOn("abc"), 'parseAmount("abc") deveria lançar (NaN)');
if (!throwsOn("-0.01")) fail('parseAmount("-0.01") deveria lançar (negativo)');
pass("validação adicionada só em feature.mjs, sem tocar no resto");
