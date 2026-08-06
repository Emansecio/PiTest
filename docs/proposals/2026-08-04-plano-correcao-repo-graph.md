# Plano de Correção do Repo Graph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o Repo Graph do Pit completo para arquivos somente de import/reexport e alterações vivas do working tree, preciso o bastante para não injetar contexto irrelevante, seguro sob seus kill-switches e mensuravelmente econômico.

**Architecture:** Preservar o Living Repo Map como fonte única de nós e arestas. Primeiro corrigir a projeção incremental; depois restringir somente a fronteira fuzzy da previsão, alinhar os consumidores ao contrato do grafo e adicionar evidência observável da eficácia do prefetch e do custo de contexto. Toda feature permanece fail-open e protegida pelo kill-switch existente.

**Tech Stack:** TypeScript, Node.js, npm workspaces, Vitest, subprocessos Git, cache JSONL do repo-map e diagnósticos de runtime de `@pit/ai`.

---

## 1. Escopo e baseline auditada

Este plano corrige todos os problemas confirmados na auditoria read-only de 2026-08-04. Ele não redesenha o grafo, não introduz serviço de AST, não muda providers e não expande a superfície de tools do core.

| Área | Baseline confirmada | Evidência primária |
|---|---|---|
| Graph coverage | 1,589 supported package files; 300 absent from the map; 298 of those contain imports. Only 631/880 test files were indexed. | [`indexFile` returns before edge extraction when `symbols` is empty](../../packages/coding-agent/src/core/repo-map/living-index.ts#L594-L630) |
| Live files | An anchored cache compares committed state and re-stats cached paths only; a new uncommitted path is never visited. | [`defaultGitDiff`](../../packages/coding-agent/src/core/repo-map/living-index.ts#L268-L279), [incremental loop](../../packages/coding-agent/src/core/repo-map/living-index.ts#L766-L832) |
| Kill-switch | `PIT_NO_REPO_GRAPH` prevents fresh extraction but cached `deps` are copied unchanged. | [kill-switch read](../../packages/coding-agent/src/core/repo-map/living-index.ts#L713-L718), [cache copy](../../packages/coding-agent/src/core/repo-map/living-index.ts#L776-L778) |
| Prediction precision | Every 3+ character word is fuzzy-matched against all symbols; the audited request produced unrelated seeds such as `Graph -> grep` and about 391 dynamic-suffix tokens. | [`promptIdentifiers`](../../packages/coding-agent/src/core/conditioning/context-composer.ts#L224-L238), [symbol fuzzy match](../../packages/coding-agent/src/core/conditioning/context-composer.ts#L322-L339) |
| Self-review scope | The system prompt forbids reading outside touched files while the graph section requests exactly that. | [system constraint](../../packages/coding-agent/src/core/self-review.ts#L163-L173), [impacted-files instruction](../../packages/coding-agent/src/core/self-review.ts#L210-L219) |
| Prefetch freshness | A stale entry misses safely, but remains resident; the prefetcher skips every resident path without checking freshness. | [`tryWarmBuffer`](../../packages/coding-agent/src/core/tools/read.ts#L226-L235), [`cache.has`](../../packages/coding-agent/src/core/built-ins/graph-prefetch-extension.ts#L207-L218) |
| Economy proof | Token gates pass, but they do not isolate graph ROI. The audited 945,598-byte cache had 1,398 entries/4,593 edges and a no-memo cache hit measured about 36.3 ms median; the proposal itself describes isolated prefetch gain as milliseconds and low urgency. | [final unconditional save](../../packages/coding-agent/src/core/repo-map/living-index.ts#L834-L840), [P6 gain statement](2026-07-22-propostas-fronteira.md#L517-L525), [tuning flags](../token-economy-tuning.md#L42-L42) |

### Restrições

- Preservar o BFS, os caps, a persistência JSONL atômica, o comportamento fail-open e os kill-switches existentes.
- Não editar `CHANGELOG.md`.
- Não adicionar nova flag `PIT_*`.
- Manter `impact` somente em discovery; não adicioná-la a `_defaultActiveToolNames()`.
- Não trocar a extração de arestas por regex por um parser neste ciclo.
- O working tree atual já contém WIP não relacionado em:
  - `packages/coding-agent/src/core/conditioning/context-composer.ts`
  - `packages/coding-agent/src/core/self-review.ts`
  - `packages/coding-agent/src/core/tools/read.ts`
  - `packages/coding-agent/test/self-review.test.ts`
- Antes de editar um arquivo sobreposto, salvar sua diff atual e aplicar a fatia planejada por cima. Nunca restaurar ou reescrever o arquivo inteiro.

## 2. Mapa de responsabilidade dos arquivos

| Arquivo | Responsabilidade neste plano |
|---|---|
| `packages/coding-agent/src/core/repo-map/living-index.ts` | Manter nós edge-only, descobrir arquivos vivos, remover dados cached sob o kill-switch e evitar regravações no-op. |
| `packages/coding-agent/test/living-repo-map.test.ts` | Cobrir por regressão todas as correções do Living Repo Map. |
| `packages/coding-agent/src/core/conditioning/context-composer.ts` | Separar grounding exato de símbolos do grounding fuzzy de alta confiança. |
| `packages/coding-agent/test/context-composer.test.ts` | Testar ruído de linguagem natural, exact match, typo code-shaped e precisão dos vizinhos. |
| `packages/coding-agent/src/core/self-review.ts` | Permitir arquivos impactados explicitamente fornecidos e continuar proibindo exploração sem relação. |
| `packages/coding-agent/test/self-review.test.ts` | Garantir que system e user prompt compartilhem o mesmo contrato de escopo. |
| `packages/coding-agent/src/core/tools/warm-file-cache.ts` | Adicionar remoção explícita de entrada stale residente. |
| `packages/coding-agent/src/core/tools/read.ts` | Expulsar entradas stale e registrar resultados hit/stale do prefetch. |
| `packages/coding-agent/src/core/built-ins/graph-prefetch-extension.ts` | Registrar aquecimentos especulativos bem-sucedidos. |
| `packages/coding-agent/test/graph-prefetch-read-cache.test.ts` | Provar expulsão stale e diagnósticos hit/stale. |
| `packages/coding-agent/test/graph-prefetch-extension.test.ts` | Provar diagnóstico warm e novo aquecimento após expulsão. |
| `packages/ai/src/utils/runtime-diagnostics.ts` | Adicionar categorias estáveis para calcular proporções hit/warm/stale. |
| `scripts/bench-repo-graph.mts` | Reproduzir custo de cache hit e medições A/B de tokens do contexto. |
| `package.json` | Expor o benchmark como `npm run bench:repo-graph`. |
| `docs/token-economy-tuning.md` | Documentar semântica corrigida dos kill-switches e contadores do prefetch. |

---

### Tarefa 1: Preservar nós somente de import e reexport

**Files:**
- Modify: `packages/coding-agent/src/core/repo-map/living-index.ts:594-635`
- Modify: `packages/coding-agent/test/living-repo-map.test.ts:24-90,291-450`

- [ ] **Passo 1: Permitir que o harness de teste retorne zero declarações**

Adicionar este membro opcional ao tipo `opts` de `makeDeps`:

```ts
extractSymbols?: (content: string, path: string) => string[];
```

Substituir o membro `extractSymbols` do harness por:

```ts
extractSymbols: (content, path) => {
	const key = rel(path);
	parseCounts[key] = (parseCounts[key] ?? 0) + 1;
	if (opts.extractSymbols) return opts.extractSymbols(content, path);
	return content
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
},
```

- [ ] **Passo 2: Escrever a regressão inicialmente falha para nó somente de import**

Adicionar sob `getLivingRepoMap — repo graph (deps) extraction`:

```ts
it("keeps an import-only file as a graph node even when it declares no symbols", async () => {
	const { deps } = makeDeps({
		head: null,
		files: {
			"index.ts": 'export * from "./dep.js";',
			"dep.ts": "export const value = 1;",
		},
		extractSymbols: (_content, path) => (path.endsWith("index.ts") ? [] : ["value"]),
		extractDeps: (_content, path) => (path === "index.ts" ? ["dep.ts"] : []),
	});

	const result = await getLivingRepoMap(CWD, deps);
	const indexEntry = result.map.entries.find((entry) => entry.path === "index.ts");

	expect(indexEntry).toEqual({
		path: "index.ts",
		symbols: [],
		mtimeMs: 1,
		deps: ["dep.ts"],
	});
});
```

- [ ] **Passo 3: Executar o teste e confirmar a falha auditada**

Run:

```powershell
cd packages/coding-agent
npx vitest --run test/living-repo-map.test.ts -t "keeps an import-only file"
```

Esperado antes da implementação: `FAIL`, pois `indexEntry` é `undefined`.

- [ ] **Passo 4: Extrair dependências antes de decidir se o arquivo é indexável**

Substituir o early-return de símbolos e a construção de arestas de `indexFile` pelo formato abaixo. Manter a extração de declarações entre a construção da entrada e o retorno final.

```ts
const symbols = deps.extractSymbols(content, abs);
const repoRelPath = toRelKey(cwd, relPath);
let fileDeps: string[] = [];
if (extractDepsEnabled && deps.extractDeps) {
	try {
		fileDeps = deps.extractDeps(content, repoRelPath, fileExists, resolveBare);
	} catch {
		fileDeps = [];
	}
}
if (symbols.length === 0 && fileDeps.length === 0) return null;

const entry: RepoMapEntry = { path: repoRelPath, symbols, mtimeMs };
if (deps.extractDeclarations && symbols.length > 0) {
	try {
		const decls = deps.extractDeclarations(content, abs);
		if (decls.length > 0) entry.decls = decls;
	} catch {
		// name-only fallback
	}
}
if (fileDeps.length > 0) entry.deps = fileDeps;
return entry;
```

Atualizar a documentação de `RepoMapEntry.symbols` para admitir array vazio em nó edge-only. Não alterar `livingRepoMapToDigests`; o filtro `symbols.length === 0` existente está correto.

- [ ] **Passo 5: Executar todo o arquivo de testes do Living Repo Map**

Run:

```powershell
cd packages/coding-agent
npx vitest --run test/living-repo-map.test.ts
```

Esperado: todos os testes passam, incluindo o novo caso somente de import.

- [ ] **Passo 6: Commitar somente esta fatia**

```powershell
git add packages/coding-agent/src/core/repo-map/living-index.ts packages/coding-agent/test/living-repo-map.test.ts
git commit -m "fix(repo-graph): retain import-only graph nodes"
```

---

### Tarefa 2: Descobrir arquivos novos do working tree e respeitar o kill-switch em cache hits

**Files:**
- Modify: `packages/coding-agent/src/core/repo-map/living-index.ts:249-279,713-839`
- Modify: `packages/coding-agent/test/living-repo-map.test.ts:94-216,291-450,649-730`

- [ ] **Passo 1: Escrever uma regressão com Git real para arquivo source untracked**

Criar repositório temporário no teste, semear o cache pelas dependências padrão, adicionar `new.ts` untracked, limpar o memo de um segundo e chamar `getLivingRepoMap` novamente:

```ts
it("discovers an untracked source file after an anchored cache was created", async () => {
	const repo = mkdtempSync(join(tmpdir(), "pit-repo-map-untracked-"));
	try {
		execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "pit@example.test"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Pit Test"], { cwd: repo });
		writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
		writeFileSync(join(repo, ".gitignore"), ".pit/\n");
		execFileSync("git", ["add", "a.ts", ".gitignore"], { cwd: repo });
		execFileSync("git", ["commit", "-m", "seed"], { cwd: repo, stdio: "ignore" });

		await getLivingRepoMap(repo);
		writeFileSync(join(repo, "new.ts"), "export const newValue = 1;\n");
		clearLivingRepoMapMemoForTest();

		const result = await getLivingRepoMap(repo);
		expect(result.map.entries.map((entry) => entry.path)).toContain("new.ts");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
```

Adicionar ao bloco existente os imports Node necessários: `execFileSync`, `mkdtempSync`, `rmSync`, `writeFileSync`, `tmpdir` e `join`. Reutilizar imports já presentes.

- [ ] **Passo 2: Escrever a regressão do kill-switch sobre `deps` em cache**

```ts
it("PIT_NO_REPO_GRAPH strips deps already present in an anchored cache", async () => {
	const previous = process.env.PIT_NO_REPO_GRAPH;
	process.env.PIT_NO_REPO_GRAPH = "1";
	try {
		const cache: LivingRepoMap = {
			version: 4,
			lastIndexedCommit: "head-sha",
			entries: [{ path: "a.ts", symbols: ["a"], deps: ["b.ts"], mtimeMs: 1 }],
		};
		const { deps, saved } = makeDeps({
			head: "head-sha",
			diff: [],
			cache,
			files: { "a.ts": "a", "b.ts": "b" },
			mtimes: { "a.ts": 1, "b.ts": 1 },
		});

		const result = await getLivingRepoMap(CWD, deps);
		expect(result.map.entries[0]?.deps).toBeUndefined();
		expect(saved.last?.entries[0]?.deps).toBeUndefined();
	} finally {
		if (previous === undefined) delete process.env.PIT_NO_REPO_GRAPH;
		else process.env.PIT_NO_REPO_GRAPH = previous;
	}
});
```

- [ ] **Passo 3: Executar os dois testes e confirmar que falham**

```powershell
cd packages/coding-agent
npx vitest --run test/living-repo-map.test.ts -t "untracked source file|strips deps already present"
```

Esperado antes da implementação: os dois testes falham.

- [ ] **Passo 4: Incluir alterações tracked e arquivos untracked no delta padrão**

Substituir `defaultGitDiff` por:

```ts
async function defaultGitDiff(cwd: string, base: string): Promise<DiffEntry[] | null> {
	const [trackedOut, untrackedOut] = await Promise.all([
		// Comparing the base commit directly with the working tree includes the
		// committed delta, staged changes, and unstaged changes in one subprocess.
		runGit(cwd, ["diff", "--name-status", base], GIT_TIMEOUT_MS),
		runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], GIT_TIMEOUT_MS),
	]);
	if (trackedOut === null || untrackedOut === null) return null;

	const byDestination = new Map<string, DiffEntry>();
	for (const line of trackedOut.split("\n")) {
		const parsed = parseDiffLine(line);
		if (parsed) byDestination.set(parsed.renameTo ?? parsed.path, parsed);
	}
	for (const path of untrackedOut.split("\0")) {
		if (path.length > 0) byDestination.set(path, { status: "A", path });
	}
	return [...byDestination.values()];
}
```

Isso mantém arquivos ignorados fora do delta e evita varredura completa a cada cache hit.

- [ ] **Passo 5: Projetar entradas em cache através do kill-switch vigente**

Substituir a cópia direta do cache por:

```ts
const byPath = new Map<string, RepoMapEntry>();
for (const cachedEntry of cache.entries) {
	const entry: RepoMapEntry = {
		path: cachedEntry.path,
		symbols: cachedEntry.symbols,
		mtimeMs: cachedEntry.mtimeMs,
	};
	if (cachedEntry.decls) entry.decls = cachedEntry.decls;
	if (extractDepsEnabled && cachedEntry.deps) entry.deps = cachedEntry.deps;
	// An edge-only node has no purpose while the graph is disabled.
	if (entry.symbols.length === 0 && entry.deps === undefined) continue;
	byPath.set(entry.path, entry);
}
```

O resultado e o JSONL persistido não podem conter `deps` quando `PIT_NO_REPO_GRAPH` for truthy, inclusive em cache hit puro.

- [ ] **Passo 6: Executar a suíte do Living Repo Map**

```powershell
cd packages/coding-agent
npx vitest --run test/living-repo-map.test.ts
```

Esperado: todos os testes passam. O teste com Git real deve passar no Windows sem deixar diretório temporário bloqueado.

- [ ] **Passo 7: Commitar somente esta fatia**

```powershell
git add packages/coding-agent/src/core/repo-map/living-index.ts packages/coding-agent/test/living-repo-map.test.ts
git commit -m "fix(repo-graph): index live files and strip cached edges"
```

---

### Tarefa 3: Parar de regravar cache do repo-map sem alterações

**Files:**
- Modify: `packages/coding-agent/src/core/repo-map/living-index.ts:789-840`
- Modify: `packages/coding-agent/test/living-repo-map.test.ts:171-215,363-390`

- [ ] **Passo 1: Fortalecer o teste de cache hit puro**

Alterar o teste existente para reter `saved` e adicionar:

```ts
expect(saved.calls).toBe(0);
```

Adicionar uma segunda asserção ao teste de kill-switch da Tarefa 2:

```ts
expect(saved.calls).toBe(1);
```

Isso distingue um no-op verdadeiro da regravação intencional única que remove arestas cached.

- [ ] **Passo 2: Executar os testes focados e confirmar a falha do hit puro**

```powershell
cd packages/coding-agent
npx vitest --run test/living-repo-map.test.ts -t "pure cache hit|strips deps already present"
```

Esperado antes da implementação: o teste de cache hit puro registra uma gravação.

- [ ] **Passo 3: Persistir somente quando o mapa serializado mudar**

Imediatamente antes do `trySave` final, calcular:

```ts
const removedCachedGraphData =
	!extractDepsEnabled && cache.entries.some((entry) => entry.deps !== undefined || entry.symbols.length === 0);
const cacheShapeChanged =
	reindexed > 0 ||
	byPath.size !== cache.entries.length ||
	cache.lastIndexedCommit !== head ||
	removedCachedGraphData;
if (cacheShapeChanged) trySave(deps, cachePath, result.map);
```

Remover o `trySave` final incondicional. Manter os saves de full-scan e diff falho, pois produzem snapshot completo novo.

- [ ] **Passo 4: Executar todo o arquivo focado**

```powershell
cd packages/coding-agent
npx vitest --run test/living-repo-map.test.ts
```

Esperado: todos os testes passam; cache hit sem mudança não grava o JSONL.

- [ ] **Passo 5: Commitar somente esta fatia**

```powershell
git add packages/coding-agent/src/core/repo-map/living-index.ts packages/coding-agent/test/living-repo-map.test.ts
git commit -m "perf(repo-map): skip unchanged cache rewrites"
```

---

### Tarefa 4: Restringir previsão fuzzy de símbolos a evidência com formato de código

**Files:**
- Modify: `packages/coding-agent/src/core/conditioning/context-composer.ts:224-238,322-339`
- Modify: `packages/coding-agent/test/context-composer.test.ts:35-156`

- [ ] **Passo 1: Adicionar regressões para o prompt em linguagem natural auditado**

```ts
it("does not fuzzy-ground ordinary prose into unrelated symbols or graph neighbors", () => {
	const entries: RepoMapEntry[] = [
		{ path: "grep.ts", symbols: ["grep"], deps: ["grep-dependent.ts"], mtimeMs: 1 },
		{ path: "run.ts", symbols: ["run"], mtimeMs: 1 },
		{ path: "pct.ts", symbols: ["pct"], mtimeMs: 1 },
		{ path: "item.ts", symbols: ["item"], mtimeMs: 1 },
		{ path: "fan.ts", symbols: ["fan"], mtimeMs: 1 },
		{ path: "grep-dependent.ts", symbols: ["dependent"], mtimeMs: 1 },
	];

	expect(
		predictRelevantFiles({
			entries,
			prompt: "Revise o Graph que o Pit tem atualmente, se é robusto, inteligente e de fato proporciona economia.",
		}),
	).toEqual([]);
});
```

Adicionar testes de preservação:

```ts
it("still grounds an exact plain-language symbol mention", () => {
	const entries: RepoMapEntry[] = [{ path: "render.ts", symbols: ["render"], mtimeMs: 1 }];
	expect(predictRelevantFiles({ entries, prompt: "inspect render" })).toEqual(["render.ts"]);
});

it("fuzzy-matches a code-shaped misspelling inside backticks", () => {
	const entries: RepoMapEntry[] = [{ path: "map.ts", symbols: ["getLivingRepoMap"], mtimeMs: 1 }];
	expect(predictRelevantFiles({ entries, prompt: "fix `getLivingRepoMop`" })).toEqual(["map.ts"]);
});
```

- [ ] **Passo 2: Executar os três testes e confirmar somente a falha de ruído**

```powershell
cd packages/coding-agent
npx vitest --run test/context-composer.test.ts -t "ordinary prose|exact plain-language|code-shaped misspelling"
```

Esperado: o caso de prosa comum falha antes da implementação; o exact match permanece um contrato protegido.

- [ ] **Passo 3: Retornar elegibilidade fuzzy junto de cada identificador do prompt**

Substituir `promptIdentifiers` por:

```ts
interface PromptIdentifier {
	value: string;
	allowFuzzy: boolean;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCodeShapedIdentifier(prompt: string, value: string): boolean {
	if (value.length < 4) return false;
	if (/[_$\d]/.test(value) || /[a-z][A-Z]/.test(value)) return true;
	const escaped = escapeRegExp(value);
	return new RegExp(`(?:\`${escaped}\`|\\b${escaped}\\s*\\()`).test(prompt);
}

function promptIdentifiers(prompt: string): PromptIdentifier[] {
	const out = new Map<string, boolean>();
	for (const match of prompt.matchAll(IDENT_RE)) {
		const value = match[0]!;
		if (value.length < 3) continue;
		out.set(value, (out.get(value) ?? false) || isCodeShapedIdentifier(prompt, value));
	}
	return [...out].map(([value, allowFuzzy]) => ({ value, allowFuzzy }));
}
```

Isso evita intencionalmente lista de stopwords em português/inglês. A regra é sintática e independente do idioma.

- [ ] **Passo 4: Preservar exact matching e restringir somente fuzzy matching**

Alterar o loop de símbolos para:

```ts
for (const { value: ident, allowFuzzy } of promptIdentifiers(input.prompt)) {
	const exact = symbolToPaths.get(ident);
	if (exact) {
		for (const path of exact) {
			add(path, SCORE_PROMPT_SYMBOL);
			strongSeeds.add(path);
		}
		continue;
	}
	if (!allowFuzzy) continue;
	const close = suggestClosest(ident, allSymbols, { maxDistance: 2, prefixMinOverlap: 64 });
	if (close) {
		for (const path of symbolToPaths.get(close) ?? []) {
			add(path, SCORE_PROMPT_SYMBOL);
			strongSeeds.add(path);
		}
	}
}
```

- [ ] **Passo 5: Executar a suíte do context composer**

```powershell
cd packages/coding-agent
npx vitest --run test/context-composer.test.ts
```

Esperado: todos os testes passam, a prosa auditada não produz previsões, símbolos exatos continuam funcionando e a expansão por vizinhos permanece determinística.

- [ ] **Passo 6: Commitar sem sobrescrever o WIP preexistente de token cap**

```powershell
git add packages/coding-agent/test/context-composer.test.ts
git add -p packages/coding-agent/src/core/conditioning/context-composer.ts
git diff --cached --check
git commit -m "fix(context): require code-shaped evidence for fuzzy grounding"
```

---

### Tarefa 5: Alinhar o escopo de sistema do self-review aos arquivos impactados

**Files:**
- Modify: `packages/coding-agent/src/core/self-review.ts:163-173`
- Modify: `packages/coding-agent/test/self-review.test.ts:323-375`

- [ ] **Passo 1: Adicionar regressão do contrato dos prompts**

```ts
it("allows touched and explicitly listed impacted files while forbidding unrelated scope", () => {
	expect(SELF_REVIEW_SYSTEM_PROMPT).toContain("explicitly listed impacted files");
	expect(SELF_REVIEW_SYSTEM_PROMPT).toContain("Do NOT review unrelated files");
	expect(SELF_REVIEW_SYSTEM_PROMPT).not.toContain("Do NOT review anything outside the touched files");
});
```

- [ ] **Passo 2: Executar o teste do prompt e confirmar a falha**

```powershell
cd packages/coding-agent
npx vitest --run test/self-review.test.ts -t "explicitly listed impacted files"
```

Esperado antes da implementação: `FAIL` na instrução atual limitada aos arquivos tocados.

- [ ] **Passo 3: Substituir a instrução de sistema contraditória**

Usar esta instrução exata em `SELF_REVIEW_SYSTEM_PROMPT`:

```ts
"Review ONLY the supplied diff summary, the touched files, and any explicitly listed impacted files (open them with read/grep/find/ls as needed). Do NOT review unrelated files.",
```

Não remover o cap de 10 arquivos impactados nem transformar a lista em worklist de mutação.

- [ ] **Passo 4: Executar a cobertura de self-review e goal completion**

```powershell
cd packages/coding-agent
npx vitest --run test/self-review.test.ts test/goal-complete-impact.test.ts
```

Esperado: os dois arquivos passam; o comportamento R9/R10 não muda.

- [ ] **Passo 5: Commitar somente o contrato de escopo por cima do WIP existente**

```powershell
git add -p packages/coding-agent/src/core/self-review.ts packages/coding-agent/test/self-review.test.ts
git diff --cached --check
git commit -m "fix(review): permit explicit graph impact context"
```

---

### Tarefa 6: Expulsar entradas stale para permitir que o prefetch as atualize

**Files:**
- Modify: `packages/coding-agent/src/core/tools/warm-file-cache.ts:74-95`
- Modify: `packages/coding-agent/src/core/tools/read.ts:226-235`
- Modify: `packages/coding-agent/test/graph-prefetch-read-cache.test.ts:40-66,103-115`
- Modify: `packages/coding-agent/test/graph-prefetch-extension.test.ts:190-228`

- [ ] **Passo 1: Ampliar as asserções de leitura stale**

In both mtime- and size-mismatch tests, add:

```ts
expect(cache.has(filePath)).toBe(false);
```

Adicionar regressão de refresh ao teste da extensão usando os helpers existentes `mockMap`, `entry`, `makeSnapshotReader`, `makeFakePi`, `toolResult`, `abs` e `flush`:

```ts
it("can warm a path again after a stale consumer evicts it", async () => {
	mockMap([entry("src/seed.ts"), entry("src/dependent.ts", ["src/seed.ts"])]);
	const cache = new WarmFileCache();
	cache.set(abs("src/dependent.ts"), { content: "stale", mtimeMs: 1, size: 5 });
	expect(cache.delete(abs("src/dependent.ts"))).toBe(true);
	const { readFileSnapshot, reads } = makeSnapshotReader({ [abs("src/dependent.ts")]: "fresh" });
	const { api, fire } = makeFakePi();
	createGraphPrefetchExtension({ cwd: CWD, getWarmFileCache: () => cache, readFileSnapshot })(api);

	fire("tool_result", toolResult("read", { path: "src/seed.ts" }));
	await flush();

	expect(reads).toEqual([abs("src/dependent.ts")]);
	expect(cache.peek(abs("src/dependent.ts"))?.content).toBe("fresh");
});
```

- [ ] **Passo 2: Executar os testes de mismatch e confirmar a falha de residência**

```powershell
cd packages/coding-agent
npx vitest --run test/graph-prefetch-read-cache.test.ts -t "mtime mismatch|size mismatch"
```

Esperado antes da implementação: o fallback para disco funciona, mas `cache.has(filePath)` permanece `true`.

- [ ] **Passo 3: Adicionar remoção explícita ao `WarmFileCache`**

```ts
/** Remove one resident path. Returns true when an entry was removed. */
delete(absolutePath: string): boolean {
	const key = canonicalPathKey(absolutePath);
	const entry = this.seen.get(key);
	if (!entry) return false;
	this.totalBytes -= entry.bytes;
	return this.seen.delete(key);
}
```

- [ ] **Passo 4: Expulsar a entrada quando o stat vivo divergir**

Alterar o ramo de mismatch em `tryWarmBuffer` para:

```ts
if (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
	cache.delete(absolutePath);
	return undefined;
}
```

Manter o fallback normal para disco; a correção continua fail-open.

- [ ] **Passo 5: Executar as duas suítes de prefetch**

```powershell
cd packages/coding-agent
npx vitest --run test/graph-prefetch-read-cache.test.ts test/graph-prefetch-extension.test.ts
```

Esperado: todos os testes passam; dado stale nunca é servido e nenhuma entrada stale bloqueia aquecimento futuro.

- [ ] **Passo 6: Commitar somente esta fatia por cima do WIP existente em `read.ts`**

```powershell
git add packages/coding-agent/src/core/tools/warm-file-cache.ts packages/coding-agent/test/graph-prefetch-read-cache.test.ts packages/coding-agent/test/graph-prefetch-extension.test.ts
git add -p packages/coding-agent/src/core/tools/read.ts
git diff --cached --check
git commit -m "fix(prefetch): evict stale warm-cache entries"
```

---

### Tarefa 7: Tornar a economia do Graph observável e reproduzível

**Files:**
- Modify: `packages/ai/src/utils/runtime-diagnostics.ts:28-100`
- Modify: `packages/coding-agent/src/core/tools/read.ts:226-235`
- Modify: `packages/coding-agent/src/core/built-ins/graph-prefetch-extension.ts:185-228`
- Modify: `packages/coding-agent/test/graph-prefetch-read-cache.test.ts`
- Modify: `packages/coding-agent/test/graph-prefetch-extension.test.ts`
- Create: `scripts/bench-repo-graph.mts`
- Modify: `package.json`

- [ ] **Passo 1: Adicionar categorias estáveis de diagnóstico**

Adicionar estes membros a `DiagnosticCategory`:

```ts
| "graph.prefetch.warm"
| "graph.prefetch.hit"
| "graph.prefetch.stale"
```

Semântica:

- `warm`: one candidate was successfully read and inserted.
- `hit`: a later foreground `read` consumed the exact cached `(mtimeMs, size)`.
- `stale`: a foreground `read` rejected and evicted a resident entry.

- [ ] **Passo 2: Registrar resultados hit e stale em `tryWarmBuffer`**

Usar o `recordDiagnostic` já importado:

```ts
if (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
	cache.delete(absolutePath);
	recordDiagnostic({
		category: "graph.prefetch.stale",
		level: "info",
		source: "read.warm-cache",
	});
	return undefined;
}
recordDiagnostic({
	category: "graph.prefetch.hit",
	level: "info",
	source: "read.warm-cache",
});
return Buffer.from(entry.content, "utf-8");
```

Não incluir conteúdo nem caminhos absolutos nos diagnósticos.

- [ ] **Passo 3: Registrar aquecimentos bem-sucedidos**

Importar `recordDiagnostic` de `@pit/ai` em `graph-prefetch-extension.ts`. Imediatamente após `cache.set(absPath, snapshot)`, adicionar:

```ts
recordDiagnostic({
	category: "graph.prefetch.warm",
	level: "info",
	source: "graph-prefetch",
	context: { bytes: snapshot.size },
});
```

- [ ] **Passo 4: Adicionar regressões dos contadores**

Usar `resetRuntimeDiagnostics()` em `beforeEach` e então verificar:

```ts
expect(getRuntimeDiagnostics().counters["graph.prefetch.hit"]?.count).toBe(1);
expect(getRuntimeDiagnostics().counters["graph.prefetch.stale"]?.count).toBe(1);
expect(getRuntimeDiagnostics().counters["graph.prefetch.warm"]?.count).toBe(1);
```

Colocar cada asserção no teste correspondente de hit, stale ou warm bem-sucedido. Importar `getRuntimeDiagnostics` e `resetRuntimeDiagnostics` de `@pit/ai`.

- [ ] **Passo 5: Criar benchmark determinístico do Graph**

Criar `scripts/bench-repo-graph.mts`:

```ts
import { performance } from "node:perf_hooks";
import {
	clearComposeContextMemoForTest,
	composeContext,
} from "../packages/coding-agent/src/core/conditioning/context-composer.ts";
import {
	clearLivingRepoMapMemoForTest,
	getLivingRepoMap,
	type RepoMapEntry,
} from "../packages/coding-agent/src/core/repo-map/living-index.ts";

const cwd = process.cwd();
const samples: number[] = [];
for (let i = 0; i < 10; i++) {
	clearLivingRepoMapMemoForTest();
	const started = performance.now();
	await getLivingRepoMap(cwd);
	samples.push(performance.now() - started);
}

const { map } = await getLivingRepoMap(cwd);
const withoutEdges: RepoMapEntry[] = map.entries.map(({ deps: _deps, ...entry }) => entry);

function measurePrompt(prompt: string, entries: RepoMapEntry[]) {
	clearComposeContextMemoForTest();
	const result = composeContext({ entries, prompt, level: "padrao" });
	return { approxTokens: result.approxTokens, predicted: result.predicted };
}

function percentile(values: number[], fraction: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

const prompts = {
	naturalLanguage:
		"Revise o Graph que o Pit tem atualmente, se é robusto, inteligente e de fato proporciona economia.",
	codeSymbol: "Review `getLivingRepoMap` and its direct dependents",
};

const context = Object.fromEntries(
	Object.entries(prompts).map(([name, prompt]) => {
		const withGraph = measurePrompt(prompt, map.entries);
		const withoutGraph = measurePrompt(prompt, withoutEdges);
		return [name, { withGraph, withoutGraph, graphTokenDelta: withGraph.approxTokens - withoutGraph.approxTokens }];
	}),
);

console.log(
	JSON.stringify(
		{
			cacheHitMs: {
				p50: Number(percentile(samples, 0.5).toFixed(2)),
				p95: Number(percentile(samples, 0.95).toFixed(2)),
				samples: samples.map((value) => Number(value.toFixed(2))),
			},
			entries: map.entries.length,
			context,
		},
		null,
		2,
	),
);
```

- [ ] **Passo 6: Expor o benchmark**

Adicionar aos scripts do `package.json` raiz:

```json
"bench:repo-graph": "tsx scripts/bench-repo-graph.mts"
```

- [ ] **Passo 7: Executar testes de diagnóstico e benchmark**

```powershell
cd packages/coding-agent
npx vitest --run test/graph-prefetch-read-cache.test.ts test/graph-prefetch-extension.test.ts
cd ../..
npm run bench:repo-graph
```

Esperado:

- Todos os testes focados passam.
- A fixture em linguagem natural retorna zero arquivos previstos e delta zero de tokens do Graph.
- A fixture com símbolo de código ainda prevê `living-index.ts` e pode adicionar somente vizinhos diretos.
- O benchmark imprime p50/p95 do cache hit e dados A/B de contexto em JSON.

- [ ] **Passo 8: Commitar a fatia de observabilidade**

```powershell
git add packages/ai/src/utils/runtime-diagnostics.ts packages/coding-agent/src/core/built-ins/graph-prefetch-extension.ts packages/coding-agent/test/graph-prefetch-read-cache.test.ts packages/coding-agent/test/graph-prefetch-extension.test.ts scripts/bench-repo-graph.mts package.json
git add -p packages/coding-agent/src/core/tools/read.ts
git diff --cached --check
git commit -m "perf(repo-graph): expose prefetch and context economy evidence"
```

---

### Tarefa 8: Atualizar documentação operacional e executar gates finais

**Files:**
- Modify: `docs/token-economy-tuning.md:42,101-102`
- Reference: `docs/proposals/2026-07-22-propostas-fronteira.md:475-525`

- [ ] **Passo 1: Corrigir a documentação das flags do Graph**

Atualizar as linhas existentes sem adicionar flags:

```markdown
| `PIT_NO_GRAPH_PREFETCH` | Desativa o prefetch preditivo pelo grafo. Com a feature ligada, `/diagnostics` expõe `graph.prefetch.warm`, `graph.prefetch.hit` e `graph.prefetch.stale`; compare `hit/warm` e `stale/warm` antes de atribuir ganho real. O cache nunca entra no contexto, portanto o prefetch continua com zero tokens, mas pode gerar I/O especulativo. | OFF | `built-ins/graph-prefetch-extension.ts` · `core/tools/read.ts` · `core/tools/warm-file-cache.ts` | `isTruthyEnvFlag` |
| `PIT_NO_REPO_GRAPH` | Desativa toda aresta do Repo Graph, inclusive `deps` já carregado de `.pit/repo-map.jsonl`. Entradas edge-only são removidas da projeção enquanto a flag está ativa, o resultado em memória não contém arestas e a persistência seguinte elimina `deps` antigos. Símbolos e declarações permanecem disponíveis. | OFF | `repo-map/living-index.ts` | `isTruthyEnvFlag` |
```

Preservar a proposta histórica P6; ela registra o design original e o ganho isolado intencionalmente modesto.

- [ ] **Passo 2: Executar a suíte focada completa do Graph**

```powershell
cd packages/coding-agent
npx vitest --run test/repo-map-edges.test.ts test/repo-map-workspace-map.test.ts test/repo-map-graph.test.ts test/living-repo-map.test.ts test/impact.test.ts test/impact-extension.test.ts test/goal-complete-impact.test.ts test/context-composer.test.ts test/graph-prefetch-extension.test.ts test/graph-prefetch-read-cache.test.ts test/self-review.test.ts
```

Esperado: todos os 11 arquivos passam. A baseline anterior era 224 testes; o total deve crescer com as novas regressões.

- [ ] **Passo 3: Executar gates de tipos e economia de tokens**

```powershell
npx tsgo --noEmit
npm run check:token-bench
```

Esperado:

- Typecheck termina com código 0.
- O gate de tokens informa `token-economy gate ok` sem regressão exact/min/max.

- [ ] **Passo 4: Executar os gates do repositório na ordem prescrita**

```powershell
npm run check:fast
npm run check
```

Esperado: ambos terminam com código 0. Se houver falha não relacionada no working tree, registrar comando e erro separadamente; não alterar arquivos fora do escopo para obter verde.

- [ ] **Passo 5: Reexecutar o benchmark e registrar o resultado no handoff**

```powershell
npm run bench:repo-graph
```

Critérios de aceite:

1. Import-only barrels exist as graph nodes with `symbols: []` and resolved `deps`.
2. A new ignored-excluded working-tree source appears without requiring a commit or full scan.
3. `PIT_NO_REPO_GRAPH=1` yields no in-memory or persisted `deps`, including from a warm v4 cache.
4. A pure cache hit does not rewrite `.pit/repo-map.jsonl`.
5. The audited natural-language request produces no fuzzy symbol seeds and no graph-added context tokens.
6. Exact symbol and explicitly code-shaped typo grounding still work.
7. Self-review may inspect touched plus explicitly listed impacted files, but nothing unrelated.
8. A stale warm-cache entry is evicted and can be warmed again.
9. `/diagnostics` exposes warm/hit/stale counts without paths or contents.
10. No claim of latency or I/O economy is made without benchmark output plus representative `hit/warm` data. If field data shows poor effectiveness, reduce `NEIGHBOR_BUDGET_PER_TURN` or default the existing prefetch feature off in a separate, evidence-backed change.

- [ ] **Passo 6: Commitar somente a documentação**

```powershell
git add docs/token-economy-tuning.md
git commit -m "docs(repo-graph): document corrected economy semantics"
```

---

## 3. Checklist de autorrevisão

- [ ] Every audited defect maps to one task and one regression test.
- [ ] Import-only nodes do not leak into file digests because `livingRepoMapToDigests` still ignores empty symbols.
- [ ] Live-file discovery excludes `.gitignore` matches through `git ls-files --others --exclude-standard`.
- [ ] The kill-switch removes cached edges before any graph consumer sees the map.
- [ ] Exact symbol matching remains broad; only fuzzy matching becomes code-shaped.
- [ ] Graph expansion remains one hop in the context composer and bounded BFS in `impact`.
- [ ] Stale cache behavior remains correctness-safe and now becomes refreshable.
- [ ] Diagnostics contain counts and byte sizes only, never source contents or absolute paths.
- [ ] Existing WIP is preserved and `CHANGELOG.md` remains untouched.
- [ ] Focused tests, typecheck, token gate, `check:fast`, and full `check` are recorded separately.

## 4. Resultado esperado

Depois da implementação, o Graph do Pit continua pequeno e fail-open, mas passa a trabalhar com dados materialmente mais completos e atuais. Prompts em linguagem natural deixam de criar cascatas por fuzzy match acidental, as instruções de review concordam sobre o escopo, entradas stale se recuperam e alegações de economia passam a depender de A/B reproduzível e contadores de runtime, não de inferência.
