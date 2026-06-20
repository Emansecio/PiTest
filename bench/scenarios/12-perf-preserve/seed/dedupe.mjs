// Remove duplicatas preservando a ordem da PRIMEIRA ocorrência. Correto, porém
// O(n²): `includes` faz uma varredura linear do acumulado a cada item, então o
// custo explode em listas grandes com muitos valores únicos.
export function dedupe(list) {
	const out = [];
	for (const x of list) {
		if (!out.includes(x)) out.push(x);
	}
	return out;
}
