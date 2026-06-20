// Aplica `fn` (assíncrona) a cada item e devolve os resultados na MESMA ordem da
// entrada. Está bugado: usa `forEach` com callback async, que NÃO é aguardado —
// collect() resolve `results` antes de qualquer tarefa terminar, devolvendo um
// array incompleto.
export async function collect(items, fn) {
	const results = [];
	items.forEach(async (item, i) => {
		results[i] = await fn(item);
	});
	return results;
}
